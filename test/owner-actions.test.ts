import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, type TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import { InviteTracker, type Invoker } from '../src/invites.ts';
import { JOINS, OwnerActions } from '../src/owner-actions.ts';
import { superviseRequests } from '../src/reader-client.ts';
import type { MtMessage } from '../src/reader.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

const big = (n: number | string) => n as never;
const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
const SELF = { id: '7000000042', username: 'reader_bot' };
const CHAT_ID = -1000000001234;
const HASH = 'AbCdEfGh1234';

const channel = (o: Partial<Api.Channel> = {}) =>
  new Api.Channel({ id: big(1234), title: 'Alpha VIP', username: 'alpha_vip', accessHash: big('987'), megagroup: true, photo: new Api.ChatPhotoEmpty(), date: T0, ...o });
const rpc = (code: string, seconds?: number) => Object.assign(new Error(code), { errorMessage: code, ...(seconds ? { seconds } : {}) });

/** A Telegram behind the REAL request door (write gate with the owner's permits, pacing, log). */
function setup() {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const calls: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const answers = new Map<string, (req: Record<string, unknown>) => unknown>();
  const entities = new Map<string, Api.Channel>([['alpha_vip', channel({ left: true })]]);
  const gram = {
    invoke: async (req: { className: string } & Record<string, unknown>) => {
      calls.push(req.className);
      if (/JoinChannel|ImportChatInvite|GetBotCallbackAnswer|SendMessage/.test(req.className)) writes.push(req);
      const a = answers.get(req.className);
      if (!a) throw new Error(`unscripted ${req.className}`);
      return a(req);
    },
    invokeWithSender: async () => undefined,
    getEntity: async (name: string) => {
      calls.push(`getEntity ${name}`);
      const e = entities.get(name.replace(/^@/, '').toLowerCase());
      if (!e) throw rpc('USERNAME_NOT_OCCUPIED');
      return e;
    },
    downloadMedia: async () => Buffer.from('a captcha picture'),
  };
  const door = superviseRequests(gram as unknown as TelegramClient, activity, () => null, { intervalMs: 1, burst: 100 });
  answers.set('channels.GetChannels', () => ({ chats: [channel()] }));
  answers.set('channels.GetParticipant', () => ({ participant: new Api.ChannelParticipantSelf({ userId: big(SELF.id), inviterId: big(1), date: clock.t - 5 }) }));
  answers.set('channels.GetFullChannel', () => ({ fullChat: { availableMinId: 0 } }));
  answers.set('channels.JoinChannel', () => ({ updates: [], users: [], chats: [channel()] }));
  answers.set('messages.GetBotCallbackAnswer', () => ({ message: 'Welcome! You can write now.', alert: false }));
  answers.set('messages.SendMessage', () => ({ updates: [], users: [], chats: [] }));
  const pulls: number[] = [];
  const tracker = new InviteTracker({
    raw: gram as unknown as Invoker,
    reader: { pullNow: async (id) => (pulls.push(id), 0) },
    store,
    activity,
    config: testConfig({ reportTo: 42, timezone: 'UTC' }),
    notify: { notify: () => undefined },
    self: SELF,
    defaults: DEFAULTS,
    now: clock.now,
    probe: async () => null,
    sleep: async () => undefined,
  });
  const scams = new Set<number>();
  const owner = new OwnerActions({ raw: gram as unknown as TelegramClient, permit: door.permit, store, activity, tracker, now: clock.now, likelyScams: () => scams });
  return { clock, store, activity, calls, writes, answers, entities, gram, tracker, owner, pulls, scams };
}

/** What a captcha bot posts for a new member: it names them, with a button to press, a link, and a page. */
const check = (id: number, date: number): MtMessage => ({
  id,
  date,
  message: 'Alpha, press the button within 60 seconds to prove you are human, or type the sum: 3 + 4',
  sender: { className: 'User', id: 555, username: 'shieldy_bot', firstName: 'Shieldy', bot: true },
  entities: [{ className: 'MessageEntityMentionName', userId: SELF.id }],
  media: { className: 'MessageMediaPhoto' },
  replyMarkup: {
    className: 'ReplyInlineMarkup',
    rows: [
      { buttons: [{ className: 'KeyboardButtonCallback', text: 'I am human', data: new Uint8Array(Buffer.from(`ok~${SELF.id}`)) }, { className: 'KeyboardButtonUrl', text: 'Rules', url: 'https://t.me/shieldy_bot?start=rules' }] },
      { buttons: [{ className: 'KeyboardButtonWebView', text: 'Verify in app' }, { className: 'KeyboardButtonUrl', text: 'Site', url: 'https://example.org/verify' }] },
    ],
  },
});

test('no write gets through the door without the owner\'s click; a click lets exactly one matching request through, briefly', async () => {
  const store = memoryStore(new Clock(T0));
  const sent: string[] = [];
  const gram = { invoke: async (req: { message?: string }) => (sent.push(String(req.message)), { updates: [] }), invokeWithSender: async () => undefined };
  const door = superviseRequests(gram as unknown as TelegramClient, new Activity(store), () => null, { intervalMs: 1, burst: 100 });
  const send = (message: string) => (gram as unknown as TelegramClient).invoke(new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message, randomId: big(1) }));
  await assert.rejects(send('hi'), /WRITE_BLOCKED/, 'no click, no write');
  door.permit('messages.SendMessage', (r) => r.message === '7');
  await assert.rejects(send('8'), /WRITE_BLOCKED/, 'not the request the owner clicked for');
  await send('7');
  await assert.rejects(send('7'), /WRITE_BLOCKED/, 'one request per click');
  door.permit('messages.SendMessage', () => true, 10);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(send('7'), /WRITE_BLOCKED/, 'a click does not keep the door open');
  door.permit('channels.JoinChannel', () => true);
  await assert.rejects(send('7'), /WRITE_BLOCKED/, 'a permit opens only its own kind of request');
  assert.deepEqual(sent, ['7']);
  const log = store.activity();
  assert.equal(log.filter((a) => a.kind === 'write' && a.actor === 'owner').length, 1);
  assert.equal(log.filter((a) => /blocked write/.test(a.detail)).length, 5);
});

test('join by @username: refused for a likely scam, sent to the app when the group approves members, else joined, read, and watched for a check', async () => {
  const env = setup();
  env.scams.add(CHAT_ID);
  assert.match((await env.owner.join('@alpha_vip')).message, /likely scam: not joined/);
  env.scams.clear();

  env.entities.set('gated', channel({ id: big(77), username: 'gated', title: 'Gated', left: true, joinRequest: true }));
  const gated = await env.owner.join('@gated');
  assert.equal(gated.state, 'app');
  assert.equal(gated.open, 'tg://resolve?domain=gated');
  env.entities.set('flagged', channel({ id: big(78), username: 'flagged', title: 'Flagged', left: true, scam: true }));
  assert.match((await env.owner.join('@flagged')).message, /SCAM: not joined/);
  assert.ok(!env.calls.includes('channels.JoinChannel'), 'nothing was sent for those');

  const r = await env.owner.join('@alpha_vip');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.state, 'joined');
  assert.equal(r.chatId, CHAT_ID);
  assert.equal(env.writes.filter((w) => w.className === 'channels.JoinChannel').length, 1);
  const row = env.store.getChat(CHAT_ID)!;
  assert.equal(row.kind, 'watched');
  assert.equal(row.enabled, true, 'read from now on');
  assert.equal(env.store.membership(CHAT_ID)!.state, 'member');
  assert.deepEqual(env.pulls, [CHAT_ID], 'its first page is fetched at once, to catch a check');
  const log = env.store.activity();
  assert.ok(log.some((a) => a.kind === 'write' && a.actor === 'owner' && a.method === 'channels.JoinChannel' && /the owner's click/.test(a.detail)), 'the write is in the log as the owner\'s');
  assert.ok(log.some((a) => a.method === 'joined' && a.actor === 'owner'));
});

test('joins are rationed: a few an hour, and none while Telegram holds the account back', async () => {
  const env = setup();
  for (let i = 0; i < JOINS.perHour; i++) {
    env.entities.set(`group${i}x`, channel({ id: big(100 + i), username: `group${i}x`, title: `G${i}`, left: true }));
    assert.equal((await env.owner.join(`@group${i}x`)).ok, true);
  }
  env.entities.set('onemore', channel({ id: big(200), username: 'onemore', title: 'One more', left: true }));
  assert.match((await env.owner.join('@onemore')).message, /joins in the last hour already/);
  env.clock.t += 3601;
  env.answers.set('channels.JoinChannel', () => {
    throw rpc('PEER_FLOOD');
  });
  assert.match((await env.owner.join('@onemore')).message, /suspects spam/);
  env.answers.set('channels.JoinChannel', () => ({ updates: [], users: [], chats: [] }));
  assert.match((await env.owner.join('@onemore')).message, /No joins until/);
});

test('a check put to the new member: its picture, a press of the owner\'s button with its exact data, a typed answer as a reply; links and pages stay in the app', async () => {
  const env = setup();
  assert.match((await env.owner.press(CHAT_ID, 900, 0, 0)).message, /not open here/, 'nothing to answer before a check was caught');
  await env.owner.join('@alpha_vip');
  env.tracker.onBatch(CHAT_ID, [check(900, env.clock.t)]);
  const m = env.tracker.views().memberships.find((x) => x.chatId === CHAT_ID)!;
  assert.equal(m.state, 'verifying', 'the banner shows it');
  const hint = m.hints[0];
  assert.deepEqual(
    hint.keys.map((k) => [k.label, k.kind, k.open, k.host]),
    [
      ['I am human', 'press', null, null],
      ['Rules', 'telegram', 'tg://resolve?domain=shieldy_bot&start=rules', null],
      ['Verify in app', 'app', null, null],
      ['Site', 'app', null, 'example.org'],
    ],
  );
  assert.ok(!JSON.stringify(hint).includes(`ok~${SELF.id}`), 'callback data never leaves the service');
  assert.equal(hint.photo, true);
  assert.equal(String(await env.owner.photo(CHAT_ID, 900)), 'a captcha picture');

  assert.match((await env.owner.press(CHAT_ID, 900, 1, 0)).message, /cannot be pressed from here/);
  assert.match((await env.owner.press(CHAT_ID, 900, 0, 1)).message, /opens Telegram/);
  const pressed = await env.owner.press(CHAT_ID, 900, 0, 0);
  assert.equal(pressed.ok, true, pressed.message);
  assert.match(pressed.message, /The bot said: Welcome!/);
  const press = env.writes.find((w) => w.className === 'messages.GetBotCallbackAnswer')!;
  assert.equal(Number(press.msgId), 900);
  assert.equal(Buffer.from(press.data as Uint8Array).toString(), `ok~${SELF.id}`, 'the exact data of the button the owner picked');

  assert.match((await env.owner.answer(CHAT_ID, 900, 'x'.repeat(65))).message, /at most 64 characters/);
  const typed = await env.owner.answer(CHAT_ID, 900, '  7 ');
  assert.equal(typed.ok, true, typed.message);
  const sent = env.writes.find((w) => w.className === 'messages.SendMessage')!;
  assert.equal(sent.message, '7');
  assert.equal((sent.replyTo as { replyToMsgId: number }).replyToMsgId, 900, 'a reply to the check');
  assert.match((await env.owner.answer(CHAT_ID, 900, '8')).message, /One moment/, 'not twice in a row');
  assert.match(env.tracker.views().memberships[0].hints[0].done ?? '', /answered «7»/);
  assert.equal(env.store.activity().filter((a) => a.kind === 'write' && a.actor === 'owner').length, 3, 'join, press, answer: each in the log');

});

test('join by invite link: an open one is joined here; one that needs approval or payment goes to the app', async () => {
  const env = setup();
  const invite = (o: Partial<Api.ChatInvite> = {}) => new Api.ChatInvite({ title: 'Alpha VIP', photo: new Api.PhotoEmpty({ id: big(0) }), participantsCount: 812, color: 0, megagroup: true, ...o });
  let next = invite({ requestNeeded: true });
  env.answers.set('messages.CheckChatInvite', () => next);
  const gated = await env.owner.join(`https://t.me/+${HASH}`);
  assert.equal(gated.state, 'app');
  assert.equal(gated.open, `tg://join?invite=${HASH}`);
  assert.ok(!env.calls.includes('messages.ImportChatInvite'));

  env.clock.t += 700; // past the 10-minute memory of the last look at this link
  next = invite();
  env.answers.set('messages.ImportChatInvite', () => ({ updates: [], users: [], chats: [channel()] }));
  const r = await env.owner.join(`https://t.me/+${HASH}`);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.chatId, CHAT_ID);
  assert.equal(env.writes.find((w) => w.className === 'messages.ImportChatInvite')!.hash, HASH);
  assert.equal(env.store.getChat(CHAT_ID)!.enabled, true);
  assert.equal(env.store.inviteByHash(HASH)!.state, 'watching');
});
