import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, type TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import { InviteTracker, type Invoker } from '../src/invites.ts';
import type { Notice, Notifier } from '../src/notify.ts';
import { superviseRequests } from '../src/reader-client.ts';
import { ReaderError, type MtMessage } from '../src/reader.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

const big = (n: number | string) => n as never;
const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
const SELF = { id: '7000000042', username: 'reader_bot' };
const CHAT_ID = -1000000001234;
const HASH = 'AbCdEfGh1234';
const LINK = `https://t.me/+${HASH}`;

const channel = (o: Partial<Api.Channel> = {}) =>
  new Api.Channel({ id: big(1234), title: 'Alpha VIP', accessHash: big('987'), megagroup: true, photo: new Api.ChatPhotoEmpty(), date: T0, ...o });
const openInvite = (o: Partial<Api.ChatInvite> = {}) => new Api.ChatInvite({ title: 'Alpha VIP', photo: new Api.PhotoEmpty({ id: big(0) }), participantsCount: 812, color: 0, megagroup: true, ...o });
const rpc = (code: string, seconds?: number) => Object.assign(new Error(code), { errorMessage: code, ...(seconds ? { seconds } : {}) });

/** A Telegram that answers by request class, behind the REAL request supervisor (write gate, pacing, log). */
function setup(opts: { reportTo?: number | null } = {}) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const calls: string[] = [];
  const answers = new Map<string, () => unknown>();
  const invites: (() => unknown)[] = [];
  const gram = {
    invoke: async (req: { className: string }) => {
      calls.push(req.className);
      if (req.className === 'messages.CheckChatInvite') {
        const next = invites.shift();
        if (!next) throw new Error('no scripted invite answer');
        return next();
      }
      const a = answers.get(req.className);
      if (!a) throw new Error(`unscripted ${req.className}`);
      return a();
    },
    invokeWithSender: async () => undefined,
  };
  superviseRequests(gram as unknown as TelegramClient, activity, () => null, { intervalMs: 1, burst: 100 });
  answers.set('channels.GetChannels', () => ({ chats: [channel()] }));
  answers.set('channels.GetParticipant', () => ({ participant: new Api.ChannelParticipantSelf({ userId: big(SELF.id), inviterId: big(1), date: clock.t - 20 }) }));
  answers.set('channels.GetFullChannel', () => ({ fullChat: { availableMinId: 0 } }));
  const pulls: number[] = [];
  const notices: Notice[] = [];
  const notify: Notifier = { notify: (n) => notices.push(n) };
  const config = testConfig({ reportTo: opts.reportTo === undefined ? 42 : opts.reportTo, timezone: 'UTC' });
  const make = () =>
    new InviteTracker({
      raw: gram as unknown as Invoker,
      reader: { pullNow: async (id) => (pulls.push(id), 0) },
      store,
      activity,
      config,
      notify,
      self: SELF,
      defaults: DEFAULTS,
      now: clock.now,
      probe: async () => null,
      sleep: async (ms) => void (clock.t += Math.ceil(ms / 1000)),
    });
  return { clock, store, activity, calls, answers, invites, pulls, notices, tracker: make(), make };
}

/** Lets the checks started by a button run to the end. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test('preview, open, "I\'ve joined": one invite check, three reads of the standing, then a source', async () => {
  const env = setup();
  env.invites.push(() => openInvite());
  const preview = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in preview));
  assert.equal(preview.invite.state, 'previewed');
  assert.equal(preview.invite.verdict, 'join');
  assert.deepEqual(preview.invite.links, { tme: LINK, tg: `tg://join?invite=${HASH}` });
  assert.deepEqual(env.calls, ['messages.CheckChatInvite']);

  const again = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in again));
  assert.equal(env.calls.length, 1, 'a second look within 10 minutes is answered from memory');

  assert.equal(env.tracker.opened(preview.invite.id)!.state, 'owner-opened');
  assert.equal(env.calls.length, 1, 'opening the link sends nothing');

  env.invites.push(() => new Api.ChatInviteAlready({ chat: channel() }));
  env.answers.set('channels.GetFullChannel', () => ({ fullChat: { availableMinId: 900 } }));
  env.tracker.confirm(preview.invite.id, 'joined');
  await settle();
  assert.deepEqual(env.calls, ['messages.CheckChatInvite', 'messages.CheckChatInvite', 'channels.GetChannels', 'channels.GetParticipant', 'channels.GetFullChannel']);
  const row = env.store.getChat(CHAT_ID)!;
  assert.equal(row.kind, 'watched');
  assert.equal(row.enabled, true);
  assert.equal(row.readerOrigin, 'dialog');
  assert.equal(row.readerPeer, JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }), 'its address is saved: never resolved by name');
  assert.equal(row.readerCursor, 900, 'history before the join is hidden: reading starts right after it');
  assert.equal(env.store.membership(CHAT_ID)!.historyFrom, 900);
  assert.ok(env.store.activity().some((a) => a.method === 'history hidden'));
  assert.equal(env.store.getInvite(preview.invite.id)!.state, 'watching');
  assert.deepEqual(env.pulls, [CHAT_ID]);
  assert.equal(env.store.activity().filter((a) => a.kind === 'write').length, 0);

  // The link has done its job: anyone holding it could join, so it is forgotten 30 days later.
  env.clock.t += 31 * 86_400;
  env.store.pruneInvites(env.clock.t);
  assert.equal(env.store.getInvite(preview.invite.id)!.hash, null);
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true, 'reading goes on: it never needed the link');
  assert.equal(env.store.membership(CHAT_ID)!.historyFrom, 900);
});

test('a group the chat-list check listed switched off is switched on when the owner confirms it', async () => {
  const env = setup();
  env.store.watchChat({ chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(CHAT_ID) }, 42, null, DEFAULTS);
  env.store.updateChat(CHAT_ID, { enabled: false, readerOrigin: 'dialog' });
  env.store.setKv(`reader_off_reason:${CHAT_ID}`, 'auto-watch off');
  env.invites.push(() => openInvite(), () => new Api.ChatInviteAlready({ chat: channel() }));
  const p = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in p));
  env.tracker.confirm(p.invite.id, 'joined');
  await settle();
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true);
  assert.equal(env.store.getKv(`reader_off_reason:${CHAT_ID}`), '');
});

test('a join request: checked on a slow schedule, one notification when approved, given up after 14 days', async () => {
  const env = setup();
  env.invites.push(() => openInvite({ requestNeeded: true }), () => openInvite({ requestNeeded: true }));
  const p = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in p));
  assert.ok(p.invite.warnings.some((w) => w.code === 'request'));
  env.tracker.confirm(p.invite.id, 'requested');
  await settle();
  let inv = env.store.getInvite(p.invite.id)!;
  assert.equal(inv.state, 'requested');
  assert.equal(inv.nextCheckAt, inv.saidAt! + 3600);

  await env.tracker.tick();
  assert.equal(env.calls.filter((c) => c === 'messages.CheckChatInvite').length, 2, 'nothing before it is due');
  env.clock.t = inv.nextCheckAt!;
  env.invites.push(() => openInvite({ requestNeeded: true }));
  await env.tracker.tick();
  inv = env.store.getInvite(p.invite.id)!;
  assert.equal(inv.nextCheckAt, inv.saidAt! + 6 * 3600);

  env.clock.t = inv.nextCheckAt!;
  env.invites.push(() => new Api.ChatInviteAlready({ chat: channel() }));
  await env.tracker.tick();
  await settle();
  assert.equal(env.store.getInvite(p.invite.id)!.state, 'watching');
  assert.deepEqual(env.notices.map((n) => n.kind), ['approved']);
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true);

  // A second request that is never answered.
  const other = setup();
  other.invites.push(() => openInvite({ requestNeeded: true }));
  const q = await other.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in q));
  for (let i = 0; i < 30; i++) other.invites.push(() => openInvite({ requestNeeded: true }));
  other.tracker.confirm(q.invite.id, 'requested');
  await settle();
  for (let day = 0; day < 16; day++) {
    other.clock.t += 86_400;
    await other.tracker.tick();
  }
  const done = other.store.getInvite(q.invite.id)!;
  assert.equal(done.state, 'no-answer');
  assert.equal(done.checks, 17, '17 checks over 14 days, then none');
  const sent = other.calls.filter((c) => c === 'messages.CheckChatInvite').length;
  other.clock.t += 5 * 86_400;
  await other.tracker.tick();
  assert.equal(other.calls.filter((c) => c === 'messages.CheckChatInvite').length, sent);
});

test('with the ration spent, the confirmation waits for it instead of asking Telegram', async () => {
  const env = setup();
  env.invites.push(() => openInvite());
  const p = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in p));
  const spent = { at: Array.from({ length: 20 }, (_, i) => [env.clock.t - 1000 + i, 'owner']), frozenUntil: 0, floods: [] };
  env.store.setKv('invite_budget', JSON.stringify(spent));
  env.tracker.confirm(p.invite.id, 'joined');
  await settle();
  const inv = env.store.getInvite(p.invite.id)!;
  assert.equal(env.calls.length, 1, 'no second check');
  assert.match(inv.note, /rationed; this check runs by itself/);
  assert.ok(inv.nextCheckAt && inv.nextCheckAt > env.clock.t);
});

test('a dead link; a group with the same title found later is linked only if the invite names that very chat', async () => {
  const env = setup();
  env.invites.push(() => openInvite(), () => Promise.reject(rpc('INVITE_HASH_EXPIRED')));
  const p = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in p));
  env.tracker.confirm(p.invite.id, 'joined');
  await settle();
  assert.equal(env.store.getInvite(p.invite.id)!.state, 'link-dead');
  const sent = env.calls.length;
  const again = await env.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in again) && again.invite.state === 'link-dead');
  assert.equal(env.calls.length, sent, 'a dead link looked at again within 10 minutes costs nothing');

  const found = { chatId: CHAT_ID, title: 'Alpha  VIP', username: null, type: 'supergroup' as const, ref: String(CHAT_ID), members: null, peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) };
  env.tracker.onReconciled({ added: [found], left: [], back: [] }, false);
  env.clock.t += 600;
  env.invites.push(() => new Api.ChatInviteAlready({ chat: channel({ id: big(5555), title: 'Alpha VIP' }) }));
  await env.tracker.tick();
  await settle();
  const linked = env.store.getInvite(p.invite.id)!;
  assert.equal(linked.chatId, -1000000005555, 'the invite goes with the chat Telegram names, not the one with the same title');
  assert.equal(env.store.membership(CHAT_ID), null, 'the look-alike gets nothing from this invite');

  const env2 = setup();
  env2.invites.push(() => openInvite(), () => Promise.reject(rpc('INVITE_HASH_EXPIRED')));
  const p2 = await env2.tracker.preview(LINK, 'owner');
  assert.ok(!('error' in p2));
  env2.tracker.confirm(p2.invite.id, 'joined');
  await settle();
  env2.tracker.onReconciled({ added: [found], left: [], back: [] }, false);
  env2.clock.t += 600;
  env2.invites.push(() => new Api.ChatInviteAlready({ chat: channel() }));
  await env2.tracker.tick();
  await settle();
  assert.equal(env2.store.getInvite(p2.invite.id)!.state, 'watching');
});

test('the first chat-list check after a start (the whole backlog) costs nothing', () => {
  const env = setup();
  const many = Array.from({ length: 300 }, (_, i) => ({ chatId: -1000000000000 - i, title: `chat ${i}`, username: null, type: 'supergroup' as const, ref: '', members: null, peer: null }));
  env.tracker.onReconciled({ added: many, left: [], back: [] }, true);
  assert.deepEqual(env.calls, []);
});

test('after a restart: pending requests keep their schedule; chats held for a check are looked at 30 s in', async () => {
  const env = setup();
  const inv = env.store.addInvite({ hash: HASH, origin: 'console', state: 'requested', verdict: 'request', title: 'Alpha VIP', said: 'requested', saidAt: T0 - 3600, checks: 1, nextCheckAt: T0 });
  env.store.watchChat({ chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(CHAT_ID), peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) }, 42, null, DEFAULTS);
  env.store.setMembership(CHAT_ID, { state: 'verifying', cause: 'restricted', joinedAt: T0 - 600, checkedAt: T0 - 600, nextCheckAt: null });
  const fresh = env.make();
  const stop = fresh.start(3_600_000);
  stop();
  assert.equal(env.store.membership(CHAT_ID)!.nextCheckAt, T0 + 30);
  env.invites.push(() => openInvite({ requestNeeded: true }));
  env.answers.set('channels.GetChannels', () => ({ chats: [channel()] }));
  env.clock.t = T0 + 31;
  await fresh.tick();
  assert.deepEqual(env.calls, ['messages.CheckChatInvite', 'channels.GetChannels']);
  assert.equal(env.store.getInvite(inv.id)!.nextCheckAt, T0 - 3600 + 6 * 3600);
  assert.equal(env.store.membership(CHAT_ID)!.state, 'member', 'free to send: the check is over');
});

test('removed: one read says why, the source goes, one notification; the membership record stays', async () => {
  const env = setup();
  env.store.watchChat({ chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(CHAT_ID), peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) }, 42, null, DEFAULTS);
  env.store.updateChat(CHAT_ID, { readerOrigin: 'dialog' });
  env.store.setMembership(CHAT_ID, { state: 'member', joinedAt: T0 - 7200, checkedAt: T0 - 7200 });
  env.answers.set('channels.GetChannels', () => ({ chats: [new Api.ChannelForbidden({ id: big(1234), accessHash: big(987), title: 'Alpha VIP', megagroup: true, untilDate: T0 + 3600 })] }));
  await env.tracker.onAccessLost(CHAT_ID, new ReaderError('x', 0, 'CHANNEL_PRIVATE'));
  await env.tracker.onAccessLost(CHAT_ID, new ReaderError('x', 0, 'CHANNEL_PRIVATE'));
  assert.deepEqual(env.calls, ['channels.GetChannels'], 'at most one look per 10 minutes');
  assert.equal(env.store.getChat(CHAT_ID), null, 'taken off Sources (a rejoin brings it back as a new chat)');
  assert.match(env.store.membership(CHAT_ID)!.detail, /removed from it until .*: taken off Sources/);
  assert.equal(env.store.membership(CHAT_ID)!.state, 'banned-until');
  assert.deepEqual(env.notices.map((n) => n.kind), ['removed']);
});

test('a public group read from outside: a timed ban pauses reading and it resumes after, at most 3 times', async () => {
  const env = setup();
  env.store.watchChat({ chatId: CHAT_ID, title: 'Public', username: 'publicgroup', type: 'supergroup', ref: '@publicgroup', peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) }, 42, null, DEFAULTS);
  env.store.updateChat(CHAT_ID, { readerOrigin: 'manual' });
  env.answers.set('channels.GetChannels', () => ({ chats: [channel({ left: true })] }));
  await env.tracker.onAccessLost(CHAT_ID, new ReaderError('x', 0, 'CHANNEL_PRIVATE'));
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true, 'not being a member is normal for a group read from outside');
  env.clock.t += 601;
  env.answers.set('channels.GetChannels', () => ({ chats: [new Api.ChannelForbidden({ id: big(1234), accessHash: big(987), title: 'Public', megagroup: true, untilDate: env.clock.t + 3600 })] }));
  await env.tracker.onAccessLost(CHAT_ID, new ReaderError('x', 0, 'CHANNEL_PRIVATE'));
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, false);
  env.clock.t += 3661;
  await env.tracker.tick();
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true, 'back on after the ban');
  assert.equal(env.store.getKv(`reenable_tries:${CHAT_ID}`), '1');
});

test('a check bot with no mute (Shieldy): a button with the account id starts the banner and one notification', async () => {
  const env = setup();
  env.store.watchChat({ chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(CHAT_ID) }, 42, null, DEFAULTS);
  env.store.setMembership(CHAT_ID, { state: 'member', joinedAt: T0 - 60, checkedAt: T0 - 60 });
  const tracker = env.make();
  const shieldy: MtMessage = {
    id: 77,
    date: T0 + 60,
    message: 'Welcome, please press the button within 60 seconds',
    sender: { className: 'User', id: 999, username: 'shieldy_bot', firstName: 'Shieldy', bot: true },
    replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: 'I am not a bot', data: Buffer.from(`${CHAT_ID}~${SELF.id}`) })] })] }) as never,
  };
  tracker.onBatch(CHAT_ID, [shieldy, shieldy]);
  const m = env.store.membership(CHAT_ID)!;
  assert.equal(m.state, 'verifying');
  assert.equal(m.cause, 'bot message');
  const view = tracker.views().memberships[0];
  assert.equal(view.hints.length, 1);
  assert.equal(view.priors, BOT_PRIOR);
  assert.match(view.openLink!, /^tg:\/\/privatepost\?channel=1234&post=77$/);
  assert.deepEqual(env.notices.map((n) => n.kind), ['verifying']);
  assert.ok(!JSON.stringify(view).includes(`~${SELF.id}`), 'button data never leaves');

  // No hint: a quiet join stays a plain member.
  const quiet = setup();
  quiet.store.setMembership(CHAT_ID, { state: 'member', joinedAt: T0 - 60, checkedAt: T0 - 60 });
  const t2 = quiet.make();
  t2.onBatch(CHAT_ID, [{ id: 5, date: T0, message: 'gm', sender: { className: 'User', id: 1, firstName: 'p' } }]);
  quiet.clock.t += 20 * 60;
  t2.onBatch(CHAT_ID, [{ ...shieldy, date: quiet.clock.t }]);
  assert.equal(quiet.store.membership(CHAT_ID)!.state, 'member', 'after 15 minutes a bot message is not a check');
});

const BOT_PRIOR = "usually about 60 s after joining (Shieldy's default; admins can change it)";

test('the write gate: joins, posts, presses, votes, read marks and bot pages never reach Telegram', async () => {
  const env = setup();
  const writes = [
    new Api.messages.ImportChatInvite({ hash: HASH }),
    new Api.channels.JoinChannel({ channel: new Api.InputChannel({ channelId: big(1), accessHash: big(2) }) }),
    new Api.channels.LeaveChannel({ channel: new Api.InputChannel({ channelId: big(1), accessHash: big(2) }) }),
    new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: 'hi', randomId: big(1) }),
    new Api.messages.GetBotCallbackAnswer({ peer: new Api.InputPeerSelf(), msgId: 1 }),
    new Api.messages.SendVote({ peer: new Api.InputPeerSelf(), msgId: 1, options: [] }),
    new Api.messages.ReadHistory({ peer: new Api.InputPeerSelf(), maxId: 1 }),
    new Api.channels.ReadHistory({ channel: new Api.InputChannel({ channelId: big(1), accessHash: big(2) }), maxId: 1 }),
    new Api.messages.RequestWebView({ peer: new Api.InputPeerSelf(), bot: new Api.InputUserSelf(), platform: 'macos' }),
    new Api.messages.StartBot({ bot: new Api.InputUserSelf(), peer: new Api.InputPeerSelf(), randomId: big(1), startParam: 'x' }),
    new Api.chatlists.JoinChatlistInvite({ slug: 'x', peers: [] }),
  ];
  const raw = (env as unknown as { calls: string[] }).calls;
  for (const w of writes) {
    await assert.rejects(
      (env.tracker as unknown as { d: { raw: Invoker } }).d.raw.invoke(w),
      (e: { errorMessage?: string }) => e.errorMessage === 'WRITE_BLOCKED',
    );
  }
  assert.deepEqual(raw, [], 'not one of them was sent');
  const blocked = env.store.activity().filter((a) => a.detail.startsWith('blocked write'));
  assert.equal(blocked.length, writes.length);
  assert.ok(blocked.every((a) => a.kind === 'error' && !a.ok));
  assert.equal(env.store.activity().filter((a) => a.kind === 'write').length, 0);
});

test('a group joined in the app without a preview: the chat-list check finds it, and a check in its first page is caught', async () => {
  const env = setup();
  env.store.watchChat({ chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(CHAT_ID), peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) }, 42, null, DEFAULTS);
  const found = { chatId: CHAT_ID, title: 'Alpha VIP', username: null, type: 'supergroup' as const, ref: String(CHAT_ID), members: null, peer: JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }) };
  env.tracker.onReconciled({ added: [found], left: [], back: [] }, false);
  // The reader's first pull of the new chat, while the standing read is still on its way.
  env.tracker.onBatch(CHAT_ID, [
    {
      id: 3,
      date: T0 - 10,
      message: 'Hello! Solve 3+4 to stay',
      sender: { className: 'User', id: 999, username: 'join_captcha_bot', firstName: 'Captcha', bot: true },
      replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: '7', data: Buffer.from(`button_captcha ${SELF.id}`) })] })] }) as never,
    },
  ]);
  await settle();
  assert.deepEqual(env.calls, ['channels.GetParticipant', 'channels.GetChannels', 'channels.GetFullChannel'], 'three reads, none twice');
  const m = env.store.membership(CHAT_ID)!;
  assert.equal(m.state, 'verifying');
  assert.equal(m.cause, 'bot message');
  assert.deepEqual(env.notices.map((n) => n.kind), ['verifying']);
  assert.deepEqual(env.pulls, [], 'the chat-list check already started its first pull');

  // An old chat that merely reappeared in the list (joined long ago): nothing to watch.
  const old = setup();
  old.answers.set('channels.GetParticipant', () => ({ participant: new Api.ChannelParticipantSelf({ userId: big(SELF.id), inviterId: big(1), date: T0 - 86_400 }) }));
  old.tracker.onReconciled({ added: [found], left: [], back: [] }, false);
  await settle();
  assert.deepEqual(old.calls, ['channels.GetParticipant']);
  assert.equal(old.store.membership(CHAT_ID), null);
});
