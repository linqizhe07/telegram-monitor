// Private groups reached by an invite link, phase 1 (docs/private-groups.md). The owner joins in
// the official Telegram app, where any "are you human?" check shows up and gets answered; this
// service only looks:
//  - a preview of the link (one messages.checkChatInvite, rationed like username lookups);
//  - after the owner says "I've joined" or "I've sent a request", ONE check, then (for a request)
//    a few more on a slow schedule until it is approved;
//  - once in: the chat becomes a source, and the account's own standing there is read at a few
//    moments (held for a check, muted, removed), with a banner and a macOS notification when the
//    owner has to act in the app.
// It never joins, answers, presses, posts or marks anything read: the request supervisor refuses
// every write before it reaches Telegram (reader-client.ts).

import { Api, type TelegramClient } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import type { Activity } from './activity.ts';
import type { Config } from './config.ts';
import {
  BOT_PRIORS,
  BUDGET,
  classifyInvite,
  classifySelf,
  DONE,
  HINT_WINDOW,
  inviteHash,
  InviteBudget,
  inviteView,
  isDeadLink,
  matchChallenge,
  normTitle,
  pendingSchedule,
  verifySchedule,
  type ChallengeHint,
  type InviteAnswer,
  type InviteFacts,
  type InviteState,
  type InviteView,
  type Lane,
  type SelfState,
} from './invite-rules.ts';
import type { NoticeKind, Notifier } from './notify.ts';
import { probeChannel, type ProbeResult, type Verdict } from './probe.ts';
import { inputPeer, type SavedPeer } from './reader-client.ts';
import { explain, toSourceInfo, withTimeout, type MembershipNotice, type MtEntity, type MtMessage, type ReaderError, type SourceInfo } from './reader.ts';
import type { ChatDefaults, ChatRow, InviteRow, MembershipRow, Store } from './store.ts';
import { localDate, localTime } from './transcript.ts';

/** The part of the GramJS client the tracker uses: `invoke`, already wrapped by superviseRequests. */
export interface Invoker {
  invoke(request: unknown): Promise<unknown>;
}

export interface TrackerDeps {
  raw: Invoker;
  reader: { pullNow(chatId: number): Promise<number> } | null;
  store: Store;
  activity: Activity;
  config: Config;
  notify: Notifier;
  self: { id: string; username: string | null };
  defaults: ChatDefaults;
  now: () => number;
  /** The probe's details for a chat the account can see (default: probeChannel, three reads). */
  probe?: (target: string, chat: MtEntity, now: number) => Promise<ProbeResult | null>;
  /** Waits (tests advance a fake clock instead). */
  sleep?: (ms: number) => Promise<void>;
  /** The console's address, for links Claude can give the owner. */
  consoleUrl?: () => string | null;
}

export interface MembershipView {
  chatId: number;
  title: string;
  state: string;
  cause: string;
  until: number | null;
  detail: string;
  joinedAt: number | null;
  historyFrom: number | null;
  viaRequest: boolean;
  checkedAt: number;
  nextCheckAt: number | null;
  hints: ChallengeHint[];
  priors: string | null;
  openLink: string | null;
}

interface PostJoinOptions {
  /** False: the chat-list check already made it a source (or listed it switched off): leave that alone. */
  makeSource?: boolean;
  /** The account's participant entry, when it was just read (no second read). */
  participant?: SelfState;
}

export type PreviewResult = (Omit<ProbeResult, 'invite'> & { invite: InviteView & { console?: string; next?: string } }) | { error: string };

const VERDICT_TO_PROBE: Record<string, Verdict> = {
  member: 'member',
  peek: 'join-needed',
  join: 'join-needed',
  request: 'request-needed',
  paid: 'join-needed',
  refused: 'unsafe',
  dead: 'not-found',
};

const FOLLOWING: InviteState[] = ['requested', 'joined', 'verifying', 'watching', 'removed'];

export class InviteTracker {
  private readonly d: TrackerDeps;
  private readonly budget: InviteBudget;
  /** Bot messages that seem to address the account, per chat: in memory only, never stored. */
  private readonly hints = new Map<number, ChallengeHint[]>();
  /**
   * Chats whose new messages are looked at for checks, until `until`: just joined (15 min), or
   * held for a check (no end). `joinedAt` bounds how old a message can be and still count.
   */
  private readonly watched = new Map<number, { joinedAt: number; until: number; verifying: boolean }>();
  private readonly running = new Set<string>();
  /** One standing check at a time per chat (a join is noticed by the chat list and confirmed by the owner at once). */
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly lastNotice = new Map<number, number>();
  private readonly lastAccessCheck = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Telegram froze the account: no scheduled checks at all. */
  private frozen = false;

  constructor(d: TrackerDeps) {
    this.d = d;
    this.budget = new InviteBudget(d.store, d.now);
    for (const m of d.store.memberships()) this.track(m);
  }

  // ── time and words ───────────────────────────────────────────────────────

  private at(t: number): string {
    const tz = this.d.config.timezone;
    return localDate(t, tz) === localDate(this.d.now(), tz) ? localTime(t, tz) : `${localDate(t, tz).slice(5)} ${localTime(t, tz)}`;
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private event(actor: string, method: string, target: string, detail: string, ok = true): void {
    this.d.activity.event(actor, method, target, detail, ok);
  }

  /** At most one notification per thing per state, across restarts. */
  private notifyOnce(key: string, kind: NoticeKind, group: string | null, body: string): void {
    const k = `notified:${key}`;
    if (this.d.store.getKv(k)) return;
    this.d.store.setKv(k, String(this.d.now()));
    this.d.notify.notify({ kind, group, body });
    this.event('notify', kind, group ?? '', 'macOS notification queued');
  }

  // ── the ration ───────────────────────────────────────────────────────────

  /** One invite check from `lane`, or why not. The owner's own checks wait out a short spacing. */
  private async spend(lane: Lane): Promise<{ ok: true } | { ok: false; message: string; retryAt: number }> {
    for (let attempt = 0; ; attempt++) {
      const r = this.budget.take(lane);
      if (r.ok) return r;
      const wait = r.retryAt - this.d.now();
      if (lane !== 'background' && attempt === 0 && wait <= BUDGET.minGap) {
        await this.sleep(wait * 1000 + 50);
        continue;
      }
      return { ok: false, message: `Invite checks are rationed (${r.reason}): the next one is possible at ${this.at(r.retryAt)}.`, retryAt: r.retryAt };
    }
  }

  private async check(hash: string): Promise<InviteAnswer> {
    return (await withTimeout(this.d.raw.invoke(new Api.messages.CheckChatInvite({ hash })), 60_000, 'the invite check')) as InviteAnswer;
  }

  /** Telegram refused an invite check: a wait pauses all of them; a frozen account stops everything. */
  private checkFailed(e: ReaderError): void {
    if (e.code === 'FLOOD_WAIT') {
      const until = this.budget.flood(e.retryAfter);
      this.event('reader', 'invite checks paused', 'Telegram', `asked the account to wait ${e.retryAfter}s during an invite check: no invite checks until ${this.at(until)}; reading goes on`, false);
      this.notifyOnce(`paused:${until}`, 'paused', null, `Telegram asked the account to slow down; invite checks resume at ${this.at(until)}. Reading goes on.`);
    } else if (/^FROZEN_/.test(e.code)) {
      this.frozen = true;
      this.event('reader', 'invite checks stopped', 'Telegram', e.message, false);
    }
  }

  // ── previews ─────────────────────────────────────────────────────────────

  private isReading(chatId: number): boolean {
    const c = this.d.store.getChat(chatId);
    return Boolean(c && c.kind === 'watched' && c.enabled);
  }

  /** A look at an invite link: who it leads to, and what to know before joining. Never joins. */
  async preview(target: string, lane: 'owner' | 'mcp'): Promise<PreviewResult> {
    const hash = inviteHash(target);
    if (!hash) return { error: 'Not an invite link (t.me/+…, t.me/joinchat/… or tg://join?invite=…).' };
    const { store } = this.d;
    const now = this.d.now();
    const known = store.inviteByHash(hash);
    const recent = known ?? store.latestInvite(hash);
    if (recent && recent.lastCheckAt && now - recent.lastCheckAt < BUDGET.cache) return this.result(recent, target, lane, null);
    const gate = await this.spend(lane);
    if (!gate.ok) return { error: gate.message };
    let facts: InviteFacts;
    try {
      facts = classifyInvite(await this.check(hash));
    } catch (err) {
      const e = explain(err);
      if (!isDeadLink(e.code)) {
        this.checkFailed(e);
        return { error: e.message };
      }
      facts = { verdict: 'dead', title: known?.title ?? '', kind: 'supergroup', members: null, about: '', verified: false, scam: false, fake: false, requestNeeded: false, paid: false, peekUntil: null, chat: null };
    }
    let details: ProbeResult | null = null;
    if (facts.chat && facts.chat.entity.className === 'Channel' && (facts.verdict === 'member' || facts.verdict === 'peek')) {
      details = await (this.d.probe ?? ((t, c, n) => probeChannel(this.d.raw as unknown as TelegramClient, t, c as unknown as Api.Channel, n)))(target, facts.chat.entity, now).catch(() => null);
    }
    let state: InviteState;
    if (facts.verdict === 'refused') state = 'refused';
    else if (facts.verdict === 'dead') state = 'link-dead';
    else if (facts.verdict === 'member') state = known && FOLLOWING.includes(known.state as InviteState) ? (known.state as InviteState) : this.isReading(facts.chat!.chatId) ? 'watching' : 'previewed';
    else state = known && (FOLLOWING.includes(known.state as InviteState) || known.state === 'owner-opened') ? (known.state as InviteState) : 'previewed';
    const patch: Partial<InviteRow> = {
      state,
      verdict: facts.verdict,
      title: facts.title || known?.title || '',
      kind: facts.kind,
      members: facts.members,
      about: facts.about || known?.about || '',
      flags: [facts.verified && 'verified', facts.scam && 'scam', facts.fake && 'fake', facts.paid && 'paid', facts.requestNeeded && 'request'].filter((x): x is string => Boolean(x)),
      peekUntil: facts.peekUntil,
      chatId: facts.chat?.chatId ?? known?.chatId ?? null,
      peer: facts.chat?.peer ?? known?.peer ?? null,
      lastCheckAt: now,
      lastResult: facts.verdict,
      note: '',
      doneAt: DONE.includes(state) ? now : null,
    };
    let row: InviteRow;
    if (known) {
      store.updateInvite(known.id, patch);
      row = store.getInvite(known.id)!;
    } else {
      row = store.addInvite({ hash, origin: lane === 'mcp' ? 'mcp' : 'console', state, verdict: facts.verdict, ...patch });
    }
    this.event(lane === 'mcp' ? 'claude' : 'console', 'invite previewed', row.title || 'an invite', `${facts.verdict} · invite ${hash.slice(0, 4)}… (looked at, not joined)`);
    return this.result(row, target, lane, details);
  }

  private result(row: InviteRow, target: string, lane: 'owner' | 'mcp', details: ProbeResult | null): PreviewResult {
    const view = inviteView(row, (t) => this.at(t), true);
    const base: Omit<ProbeResult, 'invite'> = details
      ? { ...details, target }
      : {
          target,
          verdict: VERDICT_TO_PROBE[row.verdict] ?? 'join-needed',
          summary: view.note,
          title: row.title,
          type: row.kind === 'channel' ? 'channel' : row.kind === 'group' ? 'group' : 'supergroup',
          members: row.members,
          member: row.verdict === 'member',
          flags: { verified: view.flags.verified, scam: view.flags.scam, fake: view.flags.fake },
          about: row.about,
          chatId: row.chatId ?? undefined,
        };
    delete (base as { invite?: unknown }).invite;
    const url = this.d.consoleUrl?.();
    const extra =
      lane === 'mcp'
        ? {
            console: url ? `${url}/#invite-${row.id}` : undefined,
            next:
              row.verdict === 'member'
                ? 'The account is already in this group. The owner can start reading it from the console («Read it»), or with watch_source and this link.'
                : row.verdict === 'dead'
                  ? 'This link no longer works: the owner needs a new invite link from someone in the group.'
                  : row.verdict === 'refused'
                    ? 'Telegram marks this group as scam or fake: do not join it.'
                    : 'Join in your Telegram app using links.tme or links.tg, then press «I\'ve joined» (or «I\'ve sent a request») in the console. Claude cannot join, confirm or answer checks.',
          }
        : {};
    return { ...base, summary: details ? details.summary : view.note, invite: { ...view, ...extra } };
  }

  // ── the owner's word ─────────────────────────────────────────────────────

  opened(id: number): InviteView | null {
    const row = this.d.store.getInvite(id);
    if (!row) return null;
    if (row.state === 'previewed') {
      this.d.store.updateInvite(id, { state: 'owner-opened', openedAt: this.d.now() });
      this.event('owner', 'opened invite link', row.title, 'opened in the Telegram app from the console');
    }
    return this.view(id);
  }

  /** "I've joined" / "I've sent a request": one check now (the rest runs on its own). */
  confirm(id: number, said: 'joined' | 'requested'): InviteView | null {
    const row = this.d.store.getInvite(id);
    if (!row || !row.hash) return null;
    if (!['previewed', 'owner-opened', 'link-dead', 'requested', 'no-answer'].includes(row.state)) return this.view(id);
    this.d.store.updateInvite(id, { said, saidAt: this.d.now(), checks: 0, nextCheckAt: null, doneAt: null, note: 'Checking once with Telegram…' });
    this.event('owner', said === 'joined' ? 'owner says joined' : 'owner says requested', row.title, 'one check follows');
    void this.runCheck(id, 'owner');
    return this.view(id);
  }

  /** "Check now" on a row: one owner check. */
  recheck(id: number): InviteView | null {
    const row = this.d.store.getInvite(id);
    if (!row || !row.hash) return null;
    if (!['previewed', 'owner-opened', 'link-dead', 'requested', 'no-answer'].includes(row.state)) return this.view(id);
    this.d.store.updateInvite(id, { note: 'Checking once with Telegram…' });
    void this.runCheck(id, 'owner');
    return this.view(id);
  }

  dismiss(id: number): InviteView | null {
    const row = this.d.store.getInvite(id);
    if (!row) return null;
    if (!DONE.includes(row.state as InviteState)) {
      this.d.store.updateInvite(id, { state: 'dismissed', nextCheckAt: null, doneAt: this.d.now(), note: '' });
      this.event('owner', 'stopped tracking', row.title, 'this invite is not followed any more (nothing was sent to Telegram)');
    }
    return this.view(id);
  }

  /** Reading straight away a group the account is already in, by the invite link that was checked. */
  async watchMember(hash: string): Promise<{ ok: boolean; message: string; chatId?: number }> {
    const row = this.d.store.inviteByHash(hash);
    if (!row || row.verdict !== 'member' || row.chatId === null) {
      return { ok: false, message: 'Check this invite link first: a link can be read straight away only when the account is already in the group.' };
    }
    const entity = this.entityOf(row);
    const done = await this.postJoin(row.id, { chatId: row.chatId, peer: row.peer, entity });
    return done ? { ok: true, message: `Reading ${row.title} from now on.`, chatId: row.chatId } : { ok: false, message: this.d.store.getInvite(row.id)?.note || 'Could not start reading it.' };
  }

  private entityOf(row: InviteRow): MtEntity {
    const peer = row.peer ? (JSON.parse(row.peer) as SavedPeer) : null;
    if (row.kind === 'group' && (!peer || peer.type === 'chat')) return { className: 'Chat', id: peer?.id ?? String(-(row.chatId ?? 0)), title: row.title };
    const bare = peer?.id ?? String(-(row.chatId ?? 0) - 1_000_000_000_000);
    return { className: 'Channel', id: bare, accessHash: peer?.accessHash, title: row.title, broadcast: row.kind === 'channel', megagroup: row.kind !== 'channel' };
  }

  /** The one check behind "I've joined", "Check now", the request schedule and a chat-list match. */
  private async runCheck(id: number, lane: Lane): Promise<void> {
    const key = `invite:${id}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    const { store } = this.d;
    try {
      const row = store.getInvite(id);
      if (!row || !row.hash) return;
      const gate = await this.spend(lane);
      const now = () => this.d.now();
      if (!gate.ok) {
        store.updateInvite(id, { nextCheckAt: gate.retryAt, note: `Invite checks are rationed; this check runs by itself at ${this.at(gate.retryAt)}.` });
        this.event('reader', 'invite check deferred', row.title, gate.message);
        return;
      }
      let answer: InviteAnswer;
      try {
        answer = await this.check(row.hash);
      } catch (err) {
        const e = explain(err);
        if (isDeadLink(e.code)) {
          store.updateInvite(id, { state: 'link-dead', checks: row.checks + 1, lastCheckAt: now(), lastResult: 'dead', nextCheckAt: null, doneAt: now(), note: '' });
          this.event('reader', 'invite link dead', row.title, 'the link no longer works; if the account did join, the group shows up under Sources by itself');
          return;
        }
        this.checkFailed(e);
        const next = row.state === 'requested' && row.saidAt ? pendingSchedule(row.saidAt, row.checks + 1) : null;
        store.updateInvite(id, { lastCheckAt: now(), lastResult: e.code || 'error', nextCheckAt: next ?? null, note: e.message });
        return;
      }
      const facts = classifyInvite(answer);
      const checks = row.checks + 1;
      if (facts.verdict === 'member' && facts.chat) {
        const wasPending = row.state === 'requested';
        store.updateInvite(id, { state: 'joined', checks, lastCheckAt: now(), lastResult: 'member', chatId: facts.chat.chatId, peer: facts.chat.peer ?? row.peer, title: facts.title || row.title, nextCheckAt: null, note: '' });
        if (wasPending) this.notifyOnce(`approved:${id}`, 'approved', facts.title || row.title, 'you are in. If a check appears in your Telegram app, answer it there now.');
        await this.postJoin(id, facts.chat);
        return;
      }
      const title = facts.title || row.title;
      if (row.said === 'requested' || facts.requestNeeded || row.state === 'requested') {
        const saidAt = row.saidAt ?? now();
        const next = pendingSchedule(saidAt, checks);
        if (next === null) {
          store.updateInvite(id, { state: 'no-answer', checks, lastCheckAt: now(), lastResult: facts.verdict, nextCheckAt: null, doneAt: now(), note: '' });
          this.event('reader', 'request not answered', title, 'no approval in 14 days (Telegram never reports a decline); checks stopped');
          return;
        }
        store.updateInvite(id, { state: 'requested', said: row.said ?? 'requested', saidAt, checks, lastCheckAt: now(), lastResult: facts.verdict, nextCheckAt: next, title, note: '' });
        this.event('reader', 'request pending', title, `not approved yet; next check ${this.at(next)} (${checks} of 17)`);
        return;
      }
      store.updateInvite(id, {
        checks,
        lastCheckAt: now(),
        lastResult: facts.verdict,
        nextCheckAt: null,
        title,
        note: `Telegram does not show this account in «${title}» yet. If the app showed a check or a page, finish it there, then press «I've joined» again.`,
      });
      this.event('reader', 'not a member yet', title, 'Telegram does not show the account in it yet');
    } catch (err) {
      store.updateInvite(id, { note: `The check failed: ${(err as Error).message}` });
    } finally {
      this.running.delete(key);
    }
  }

  // ── once in ──────────────────────────────────────────────────────────────

  private peerFor(chatId: number, peer: string | null): SavedPeer | null {
    const json = peer ?? this.d.store.getChat(chatId)?.readerPeer ?? null;
    if (!json) return null;
    try {
      return JSON.parse(json) as SavedPeer;
    } catch {
      return null;
    }
  }

  /** The account's own standing in a chat: channels.getChannels (or messages.getChats), one read. */
  private async readSelf(chatId: number, peer: SavedPeer | null, fallback: MtEntity | null): Promise<SelfState> {
    const now = this.d.now();
    try {
      if (peer?.type === 'channel') {
        const r = (await this.d.raw.invoke(new Api.channels.GetChannels({ id: [inputPeer(peer) as Api.InputPeerChannel] }))) as { chats: unknown[] };
        return classifySelf({ chat: r.chats[0] as never }, now);
      }
      if (peer?.type === 'chat' || (chatId < 0 && chatId > -1_000_000_000_000)) {
        const r = (await this.d.raw.invoke(new Api.messages.GetChats({ id: [returnBigInt(String(-chatId))] }))) as { chats: unknown[] };
        return classifySelf({ chat: r.chats[0] as never }, now);
      }
    } catch (err) {
      return classifySelf({ error: explain(err).code || (err as Error).message }, now);
    }
    return fallback ? classifySelf({ chat: fallback as never }, now) : { state: 'unknown', until: null, detail: 'no saved address for this chat' };
  }

  private serial<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.chains.set(chatId, next.catch(() => undefined));
    return next;
  }

  /**
   * After a join (or when a group the account is already in is picked by its invite link): its
   * standing, how it joined, and whether earlier history is hidden; then it becomes a source
   * (switched on: the owner asked for this one) and is read.
   */
  private postJoin(inviteId: number | null, chat: { chatId: number; peer: string | null; entity: MtEntity }, opts: PostJoinOptions = {}): Promise<boolean> {
    return this.serial(chat.chatId, () => this.postJoinNow(inviteId, chat, opts));
  }

  private async postJoinNow(inviteId: number | null, chat: { chatId: number; peer: string | null; entity: MtEntity }, opts: PostJoinOptions): Promise<boolean> {
    const { store } = this.d;
    const now = this.d.now();
    const title = chat.entity.title ?? store.getChat(chat.chatId)?.title ?? String(chat.chatId);
    const peer = this.peerFor(chat.chatId, chat.peer);
    const fresh = store.membership(chat.chatId);
    let self: SelfState;
    let joinedAt = now;
    let viaRequest = false;
    let historyFrom: number | null = null;
    if (fresh && fresh.joinedAt && now - fresh.checkedAt < 120 && !['removed', 'banned', 'banned-until', 'unknown'].includes(fresh.state)) {
      // Just read (the chat-list check found the join a moment ago): no second round of requests.
      self = { state: fresh.state as SelfState['state'], until: fresh.untilDate, detail: fresh.detail };
      joinedAt = fresh.joinedAt;
      viaRequest = fresh.viaRequest;
      historyFrom = fresh.historyFrom;
    } else {
      self = await this.readSelf(chat.chatId, peer, chat.entity);
      if (peer?.type === 'channel') {
        const input = inputPeer(peer) as Api.InputPeerChannel;
        if (opts.participant) {
          joinedAt = opts.participant.joinedAt ?? now;
          viaRequest = Boolean(opts.participant.viaRequest);
        } else {
          try {
            const p = (await this.d.raw.invoke(new Api.channels.GetParticipant({ channel: input, participant: new Api.InputPeerSelf() }))) as { participant: unknown };
            const s = classifySelf({ participant: p.participant as never }, now);
            if (s.joinedAt) joinedAt = s.joinedAt;
            viaRequest = Boolean(s.viaRequest);
            if (self.state === 'unknown') self = s;
          } catch (err) {
            if (self.state === 'unknown') self = classifySelf({ error: explain(err).code }, now);
          }
        }
        try {
          const full = (await this.d.raw.invoke(new Api.channels.GetFullChannel({ channel: input }))) as { fullChat?: { availableMinId?: number } };
          const min = full.fullChat?.availableMinId ?? 0;
          if (min > 0) historyFrom = min;
        } catch {
          // the standing is what matters; hidden history is a nicety
        }
      }
    }
    const gone = self.state === 'removed' || self.state === 'banned' || self.state === 'banned-until';
    let reading = false;
    if (!gone && opts.makeSource !== false) reading = this.makeSource(inviteId, chat, title);
    else reading = this.isReading(chat.chatId);
    if (reading && historyFrom && store.getChat(chat.chatId)?.readerCursor === null) {
      // History before the join is hidden: start right after what this account can see.
      store.updateChat(chat.chatId, { readerCursor: historyFrom });
      store.setKv(`reader_cursor_date:${chat.chatId}`, String(now));
      this.event('reader', 'history hidden', title, `this group hides messages from before your join: reading starts after message #${historyFrom}`);
    }
    const verifying = self.state === 'verifying';
    const m = store.setMembership(chat.chatId, {
      state: self.state === 'unknown' ? 'member' : self.state,
      cause: verifying ? 'restricted' : '',
      untilDate: self.until,
      detail: self.detail,
      viaRequest,
      joinedAt,
      historyFrom,
      inviteId: inviteId ?? fresh?.inviteId ?? null,
      checkedAt: now,
      nextCheckAt: verifying ? verifySchedule(joinedAt, 0) : null,
      recheckCount: 0,
    });
    this.track(m);
    if (inviteId !== null) {
      store.updateInvite(inviteId, { state: gone ? 'removed' : verifying ? 'verifying' : 'watching', joinedAt, chatId: chat.chatId, doneAt: null, nextCheckAt: null });
    }
    if (gone) {
      this.removed(chat.chatId, self, title);
      return false;
    }
    this.event(
      'reader',
      'membership',
      title,
      [`member since ${this.at(joinedAt)}`, viaRequest ? 'via request' : '', historyFrom ? `history from #${historyFrom}` : '', self.detail].filter(Boolean).join(' · '),
    );
    if (verifying) this.enterVerifying(chat.chatId, title, 'restricted');
    else if (this.hints.get(chat.chatId)?.length) this.enterVerifying(chat.chatId, title, 'bot message');
    if (reading && opts.makeSource !== false) {
      void this.d.reader
        ?.pullNow(chat.chatId)
        .then((n) => this.event('reader', 'first pull', title, `${n} messages`))
        .catch((err) => this.event('reader', 'first pull', title, (err as Error).message, false));
    }
    return reading;
  }

  /** Switches the chat on as a source (it may already be one, listed switched off). */
  private makeSource(inviteId: number | null, chat: { chatId: number; peer: string | null; entity: MtEntity }, title: string): boolean {
    const { store, config } = this.d;
    const note = (text: string) => inviteId !== null && store.updateInvite(inviteId, { note: text });
    if (config.reportTo === null) {
      note('Set PULSE_OWNER_IDS or PULSE_REPORT_TO in .env so digests have somewhere to go; then it is read automatically.');
      return false;
    }
    let info: SourceInfo;
    try {
      info = toSourceInfo(chat.entity);
    } catch (err) {
      note((err as Error).message);
      this.event('reader', 'not added', title, (err as Error).message);
      return false;
    }
    if (!info.peer && chat.peer) info = { ...info, peer: chat.peer };
    const row = store.getChat(info.chatId);
    if (row && (row.kind === 'group' || row.kind === 'report')) return false; // the bot's own chats
    if (row?.kind === 'watched') {
      if (!row.enabled) this.event('owner', 'switched on', row.title, 'joined through its invite link: reading it');
      store.updateChat(info.chatId, { enabled: true, readerError: null, ...(info.peer ? { readerPeer: info.peer } : {}) });
    } else {
      store.watchChat(info, config.reportTo, null, this.d.defaults);
      this.event('reader', 'new chat', info.title, `joined through its invite link: reading it (from ${this.d.store.getChat(info.chatId)?.readerCursor ? 'where it stopped' : 'up to 24 hours back'})`);
    }
    if (!store.getChat(info.chatId)?.readerOrigin) store.updateChat(info.chatId, { readerOrigin: 'dialog' });
    store.setKv(`reader_off_reason:${info.chatId}`, '');
    return true;
  }

  private track(m: MembershipRow): void {
    const recent = m.joinedAt !== null && this.d.now() - m.joinedAt <= HINT_WINDOW;
    if (m.state === 'verifying' || (m.state === 'member' && recent)) {
      const joinedAt = m.joinedAt ?? this.d.now();
      this.watched.set(m.chatId, { joinedAt, until: m.state === 'verifying' ? Number.POSITIVE_INFINITY : joinedAt + HINT_WINDOW, verifying: m.state === 'verifying' });
    } else {
      this.watched.delete(m.chatId);
      this.hints.delete(m.chatId);
    }
  }

  private enterVerifying(chatId: number, title: string, cause: 'restricted' | 'bot message'): void {
    const { store } = this.d;
    const m = store.membership(chatId);
    if (!m) return;
    if (m.state !== 'verifying') {
      store.setMembership(chatId, { state: 'verifying', cause, nextCheckAt: verifySchedule(m.joinedAt ?? this.d.now(), 0), recheckCount: 0 });
      if (m.inviteId !== null) store.updateInvite(m.inviteId, { state: 'verifying' });
    }
    this.track(store.membership(chatId)!);
    this.event(
      'reader',
      'verification in progress',
      title,
      cause === 'restricted' ? 'Telegram shows the account as restricted there (it cannot send yet): answer the check in your Telegram app' : 'a bot addressed the account right after it joined: answer it in your Telegram app',
    );
    this.notifyOnce(`verifying:${chatId}:${m.joinedAt ?? 0}`, 'verifying', title, 'answer it in your Telegram app.');
  }

  /** The account is out of a chat: reading stops (a rejoin found by the chat-list check turns it back on). */
  private removed(chatId: number, self: SelfState, title: string): void {
    const { store } = this.d;
    const text =
      self.state === 'banned-until' && self.until
        ? `removed from it until ${this.at(self.until)} (then you may rejoin, in your Telegram app): reading stopped`
        : self.state === 'banned'
          ? 'banned from it: reading stopped'
          : 'no longer a member (left or removed): reading stopped';
    const m = store.membership(chatId);
    const long = m?.joinedAt && this.d.now() - m.joinedAt > 86_400 && !this.hints.get(chatId)?.length;
    const detail = `${text}${long ? '. Removed more than a day after joining with no check seen: looks like an inactivity clean-up or a ban-list (CAS) removal' : ''}`;
    if (store.getChat(chatId)?.kind === 'watched') {
      store.updateChat(chatId, { enabled: false, readerError: detail.slice(0, 300) });
      store.setKv(`reader_off_reason:${chatId}`, 'left');
    }
    store.setMembership(chatId, { state: self.state, untilDate: self.until, detail, checkedAt: this.d.now(), nextCheckAt: null });
    if (m?.inviteId) store.updateInvite(m.inviteId, { state: 'removed', nextCheckAt: null });
    this.watched.delete(chatId);
    this.hints.delete(chatId);
    this.event('reader', 'removed', title, detail, false);
    this.notifyOnce(`removed:${chatId}:${m?.joinedAt ?? 0}`, 'removed', title, `${text}.`);
  }

  /** "I've answered it — check now", the schedule, or a notice: one read of the account's standing. */
  checkMembership(chatId: number): Promise<{ ok: boolean; message: string; state?: string }> {
    return this.serial(chatId, () => this.checkMembershipNow(chatId));
  }

  private async checkMembershipNow(chatId: number): Promise<{ ok: boolean; message: string; state?: string }> {
    const { store } = this.d;
    const m = store.membership(chatId);
    const chat = store.getChat(chatId);
    if (!m) return { ok: false, message: 'This chat is not being watched for checks or removals.' };
    const title = chat?.title ?? String(chatId);
    const self = await this.readSelf(chatId, this.peerFor(chatId, null), null);
    const now = this.d.now();
    const n = m.recheckCount + 1;
    if (self.state === 'removed' || self.state === 'banned' || self.state === 'banned-until') {
      this.removed(chatId, self, title);
      return { ok: true, message: `«${title}»: ${store.membership(chatId)!.detail}.`, state: self.state };
    }
    if (self.state === 'unknown') {
      store.setMembership(chatId, { checkedAt: now, recheckCount: n, detail: self.detail, nextCheckAt: m.state === 'verifying' ? verifySchedule(m.joinedAt ?? now, n) : null });
      return { ok: false, message: `Could not tell: ${self.detail}.` };
    }
    if (self.state === 'verifying') {
      const next = verifySchedule(m.joinedAt ?? now, n);
      if (next === null) {
        store.setMembership(chatId, { state: 'muted', checkedAt: now, recheckCount: n, nextCheckAt: null, untilDate: self.until, detail: 'still cannot send there after 7 days; reading works' });
        if (m.inviteId !== null) store.updateInvite(m.inviteId, { state: 'watching' });
        this.track(store.membership(chatId)!);
        this.event('reader', 'muted', title, 'the account still cannot send there after 7 days; reading works, nothing else is checked');
        return { ok: true, message: `«${title}»: still restricted after 7 days; reading works.`, state: 'muted' };
      }
      if (m.state !== 'verifying') this.enterVerifying(chatId, title, 'restricted');
      store.setMembership(chatId, { checkedAt: now, recheckCount: n, nextCheckAt: next, untilDate: self.until, detail: self.detail });
      return { ok: true, message: `«${title}»: still held for a check (cannot send yet). Answer it in your Telegram app.`, state: 'verifying' };
    }
    // A member, free to send.
    const hintOnly = m.state === 'verifying' && m.cause === 'bot message';
    const windowOpen = m.joinedAt !== null && now - m.joinedAt < HINT_WINDOW;
    if (hintOnly && windowOpen) {
      store.setMembership(chatId, { checkedAt: now, recheckCount: n, nextCheckAt: m.joinedAt! + HINT_WINDOW });
      return { ok: true, message: `«${title}»: still a member. A bot addressed you there: if it asked for something, answer it in your Telegram app.`, state: 'verifying' };
    }
    store.setMembership(chatId, { state: 'member', cause: '', checkedAt: now, recheckCount: n, nextCheckAt: null, untilDate: null, detail: self.detail });
    if (m.inviteId !== null && ['verifying', 'joined', 'removed'].includes(store.getInvite(m.inviteId)?.state ?? '')) store.updateInvite(m.inviteId, { state: 'watching' });
    this.track(store.membership(chatId)!);
    if (m.state === 'verifying') this.event('reader', 'verification over', title, 'the account is a member and can send: nothing left to answer');
    return { ok: true, message: `«${title}»: a member${self.detail ? ` (${self.detail})` : ''}. Nothing left to answer.`, state: 'member' };
  }

  // ── hooks from the reader and the connection ─────────────────────────────

  /** Every page of history the reader fetched: in a just-joined chat, look for checks addressed to the account. */
  onBatch(chatId: number, batch: MtMessage[]): void {
    const w = this.watched.get(chatId);
    if (!w) return;
    if (!w.verifying && this.d.now() > w.until) {
      this.watched.delete(chatId);
      return;
    }
    for (const m of batch) {
      const h = matchChallenge(m, this.d.self, w.joinedAt, chatId);
      if (!h) continue;
      const list = this.hints.get(chatId) ?? [];
      if (list.some((x) => x.msgId === h.msgId)) continue;
      list.push(h);
      if (list.length > 10) list.shift();
      this.hints.set(chatId, list);
      // Without a standing row yet (a join the chat-list check just found), the hint waits for it.
      if (!w.verifying && this.d.store.membership(chatId)) {
        this.enterVerifying(chatId, this.d.store.getChat(chatId)?.title ?? String(chatId), 'bot message');
        w.verifying = true;
      }
    }
  }

  /** A pull failed with CHANNEL_PRIVATE / CHAT_FORBIDDEN: find out why, once. */
  async onAccessLost(chatId: number, _err: ReaderError): Promise<void> {
    const last = this.lastAccessCheck.get(chatId) ?? 0;
    if (this.d.now() - last < 600) return;
    this.lastAccessCheck.set(chatId, this.d.now());
    const { store } = this.d;
    const chat = store.getChat(chatId);
    if (!chat || chat.kind !== 'watched') return;
    const self = await this.readSelf(chatId, this.peerFor(chatId, null), null);
    if (self.state === 'member' || self.state === 'verifying' || self.state === 'unknown') return; // a passing error
    if (chat.readerOrigin === 'dialog' || store.membership(chatId)) {
      if (!store.membership(chatId)) store.setMembership(chatId, { state: self.state, checkedAt: this.d.now() });
      this.removed(chatId, self, chat.title);
      return;
    }
    // A public group read from outside: only an explicit ban changes anything (being "not a member" is normal there).
    if (self.state === 'banned' || self.state === 'banned-until') {
      const tries = Number(store.getKv(`reenable_tries:${chatId}`) ?? 0);
      const detail =
        self.state === 'banned-until' && self.until
          ? `the account is banned from this group until ${this.at(self.until)}${tries < 3 ? ': reading resumes by itself after that' : ''}`
          : 'the account is banned from this group, so it cannot be read from outside either';
      store.updateChat(chatId, { enabled: false, readerError: detail });
      store.setKv(`reader_off_reason:${chatId}`, 'banned');
      if (self.state === 'banned-until' && self.until && tries < 3) store.setKv(`reenable_at:${chatId}`, String(self.until + 60));
      this.event('reader', 'banned', chat.title, detail, false);
    }
  }

  /** What a chat-list check found. `first` is the first check after start (the whole backlog: skipped). */
  onReconciled(r: { added: SourceInfo[]; left: ChatRow[]; back?: SourceInfo[] }, first: boolean): void {
    const { store } = this.d;
    const now = this.d.now();
    const waiting = store.invites().filter((i) => i.hash && (['requested', 'owner-opened', 'link-dead'].includes(i.state) || (i.state === 'previewed' && i.said)));
    const linked = new Set<number>();
    for (const c of r.added) {
      for (const i of waiting) {
        if (normTitle(i.title) !== normTitle(c.title) || (i.chatId !== null && i.chatId !== c.chatId)) continue;
        // A title match is only a reason to check: the invite itself must name this chat.
        store.updateInvite(i.id, { nextCheckAt: now });
        linked.add(c.chatId);
      }
    }
    if (first) return;
    const fresh = [...r.added, ...(r.back ?? [])].filter((c) => !linked.has(c.chatId)).slice(0, 3);
    // Their first page is being fetched right now: look at it for checks (joined at most 30 min ago),
    // until the standing read below says whether the join really is fresh.
    for (const c of fresh) if (!this.watched.has(c.chatId)) this.watched.set(c.chatId, { joinedAt: now - 30 * 60, until: now + 10 * 60, verifying: false });
    if (fresh.length) void this.healthForFound(fresh);
    const lost = r.left.filter((c) => store.membership(c.chatId) && !['removed', 'banned', 'banned-until'].includes(store.membership(c.chatId)!.state)).slice(0, 3);
    if (lost.length) void this.classifyLeft(lost);
  }

  /** Groups the owner joined in the app without previewing them: if the join is fresh, watch for a check. */
  private async healthForFound(chats: SourceInfo[]): Promise<void> {
    for (const c of chats) {
      const peer = this.peerFor(c.chatId, c.peer);
      if (peer?.type !== 'channel') continue;
      try {
        const p = (await this.d.raw.invoke(new Api.channels.GetParticipant({ channel: inputPeer(peer) as Api.InputPeerChannel, participant: new Api.InputPeerSelf() }))) as { participant: unknown };
        const s = classifySelf({ participant: p.participant as never }, this.d.now());
        if (!s.joinedAt || this.d.now() - s.joinedAt > 30 * 60) {
          // Not a fresh join (an old chat moved, unarchived, or rejoined long ago): nothing to watch for.
          if (!this.d.store.membership(c.chatId)) {
            this.watched.delete(c.chatId);
            this.hints.delete(c.chatId);
          }
          continue;
        }
        const entity: MtEntity = { className: 'Channel', id: peer.id, accessHash: peer.accessHash, title: c.title, broadcast: c.type === 'channel' };
        await this.postJoin(null, { chatId: c.chatId, peer: c.peer, entity }, { makeSource: false, participant: s });
      } catch {
        // not knowing is fine: this is only for the banner
        if (!this.d.store.membership(c.chatId)) this.watched.delete(c.chatId);
      }
    }
  }

  private async classifyLeft(rows: ChatRow[]): Promise<void> {
    for (const row of rows) {
      const self = await this.readSelf(row.chatId, this.peerFor(row.chatId, null), null);
      if (self.state === 'member' || self.state === 'verifying' || self.state === 'unknown') continue;
      this.removed(row.chatId, self, row.title);
    }
  }

  /** Telegram said a chat changed: for a chat held for a check, look again shortly. */
  onNotice(n: MembershipNotice): void {
    if (n.chatId === null) return;
    const m = this.d.store.membership(n.chatId);
    if (!m || !(m.state === 'verifying' || m.state === 'muted' || this.watched.has(n.chatId))) return;
    const now = this.d.now();
    if (now - (this.lastNotice.get(n.chatId) ?? 0) < 60) return;
    const day = localDate(now, 'UTC');
    const [d, c] = m.checksDay.split(':');
    const count = d === day ? Number(c) || 0 : 0;
    if (count >= 30) return;
    this.lastNotice.set(n.chatId, now);
    this.d.store.setMembership(n.chatId, { nextCheckAt: now + 5, checksDay: `${day}:${count + 1}` });
  }

  // ── the clock ────────────────────────────────────────────────────────────

  /** One step: expire stale rows, then at most one invite check and one standing check. */
  async tick(): Promise<void> {
    const { store } = this.d;
    const now = this.d.now();
    for (const i of store.invites()) {
      const idle = i.openedAt ?? i.createdAt;
      if ((i.state === 'previewed' || i.state === 'owner-opened') && !i.said && now - idle > 7 * 86_400) {
        store.updateInvite(i.id, { state: 'expired', nextCheckAt: null, doneAt: now });
      }
    }
    for (const [chatId, raw] of [...this.reenableDue(now)]) {
      store.setKv(`reenable_at:${chatId}`, '');
      store.setKv(`reenable_tries:${chatId}`, String(raw + 1));
      const chat = store.getChat(chatId);
      if (chat && !chat.enabled && store.getKv(`reader_off_reason:${chatId}`) === 'banned') {
        store.updateChat(chatId, { enabled: true, readerError: null });
        store.setKv(`reader_off_reason:${chatId}`, '');
        store.setKv(`reader_floor:${chatId}`, String(now - 86_400));
        this.event('reader', 'ban over', chat.title, 'the ban should be over: reading again (from up to 24 hours back)');
      }
    }
    if (this.frozen) return;
    const [inv] = store.dueInvites(now);
    if (inv) await this.runCheck(inv.id, 'background');
    const [mem] = store.dueMemberships(now);
    if (mem) await this.checkMembership(mem.chatId).catch(() => undefined);
  }

  private reenableDue(now: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const c of this.d.store.listChats(false)) {
      const at = Number(this.d.store.getKv(`reenable_at:${c.chatId}`) || 0);
      if (at && at <= now) out.set(c.chatId, Number(this.d.store.getKv(`reenable_tries:${c.chatId}`) ?? 0));
    }
    return out;
  }

  /** Starts the 30-second clock; chats held for a check get a look 30 s after start. Returns stop. */
  start(tickMs = 30_000): () => void {
    const now = this.d.now();
    for (const m of this.d.store.memberships()) {
      if (m.state === 'verifying') this.d.store.setMembership(m.chatId, { nextCheckAt: now + 30 });
    }
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.tick()
        .catch((err) => this.d.activity.event('reader', 'invite tracker', '', (err as Error).message, false))
        .finally(() => (busy = false));
    }, tickMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }

  // ── what the console shows ───────────────────────────────────────────────

  view(id: number): InviteView | null {
    const row = this.d.store.getInvite(id);
    return row ? inviteView(row, (t) => this.at(t), true) : null;
  }

  views(): { invites: (InviteView & { checking: boolean })[]; memberships: MembershipView[]; budget: ReturnType<InviteBudget['view']> } {
    const { store } = this.d;
    const invites = store.invites().map((r) => ({ ...inviteView(r, (t) => this.at(t), true), checking: this.running.has(`invite:${r.id}`) }));
    const memberships = store.memberships().map((m) => {
      const chat = store.getChat(m.chatId);
      const hints = this.hints.get(m.chatId) ?? [];
      const bot = hints.find((h) => h.sender.bot && h.sender.username)?.sender.username?.toLowerCase() ?? null;
      const bare = -m.chatId - 1_000_000_000_000;
      const post = hints.length ? hints[hints.length - 1].msgId : (chat?.readerCursor ?? 0);
      return {
        chatId: m.chatId,
        title: chat?.title ?? String(m.chatId),
        state: m.state,
        cause: m.cause,
        until: m.untilDate,
        detail: m.detail,
        joinedAt: m.joinedAt,
        historyFrom: m.historyFrom,
        viaRequest: m.viaRequest,
        checkedAt: m.checkedAt,
        nextCheckAt: m.nextCheckAt,
        hints,
        priors: bot ? (BOT_PRIORS[bot] ?? null) : null,
        openLink: bare > 0 ? `tg://privatepost?channel=${bare}${post ? `&post=${post}` : ''}` : null,
      };
    });
    return { invites, memberships, budget: this.budget.view() };
  }
}
