import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatIdOf, explain, parseRef, Reader, toStored, type MtClient, type MtEntity, type MtMessage } from '../src/reader.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

const GROUP: MtEntity = { className: 'Channel', id: 1987654321, title: 'Binance 中文', username: 'binance_cn_test', megagroup: true, participantsCount: 120_000 };
const GROUP_ID = -1001987654321;

/** An in-memory MTProto peer: getMessages pages newest-first like messages.getHistory. */
class FakeMt implements MtClient {
  entities = new Map<string | number, MtEntity>([['binance_cn_test', GROUP], [GROUP_ID, GROUP]]);
  /** Chats the account has joined; their ids become resolvable only after getDialogs, like GramJS after a restart. */
  dialogs: { entity: MtEntity; title: string }[] = [];
  messages: MtMessage[] = [];
  historyCalls = 0;
  /** Throw on the nth history call (1-based), to simulate the connection dropping mid-pull. */
  failOnCall = 0;
  async getEntity(ref: string | number): Promise<MtEntity> {
    const e = this.entities.get(ref);
    if (!e) throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    return e;
  }
  async getDialogs(): Promise<{ entity?: MtEntity; title?: string }[]> {
    for (const d of this.dialogs) this.entities.set(chatIdOf(d.entity), d.entity);
    return [...this.dialogs, { entity: user(1, 'A friend'), title: 'A friend' }];
  }
  async getMessages(_e: MtEntity, p: { limit?: number; offsetId?: number; minId?: number; ids?: number[]; reverse?: boolean; offsetDate?: number }) {
    if (p.ids) return p.ids.map((id) => this.messages.find((m) => m.id === id));
    this.historyCalls++;
    if (this.failOnCall && this.historyCalls === this.failOnCall) throw Object.assign(new Error('Connection closed'), { errorMessage: 'Connection closed' });
    const limit = p.limit ?? 100;
    if (p.offsetDate) {
      return this.messages.filter((m) => m.date < p.offsetDate!).sort((a, b) => b.id - a.id).slice(0, limit);
    }
    if (p.reverse) {
      return this.messages.filter((m) => m.id > (p.minId ?? 0)).sort((a, b) => a.id - b.id).slice(0, limit);
    }
    return this.messages
      .filter((m) => m.id > (p.minId ?? 0) && (!p.offsetId || m.id < p.offsetId))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
}

const user = (id: number, firstName: string, extra: Partial<MtEntity> = {}): MtEntity => ({ className: 'User', id, firstName, ...extra });
const msg = (id: number, date: number, text: string, extra: Partial<MtMessage> = {}): MtMessage => ({ id, date, message: text, sender: user(500 + (id % 5), `user${id % 5}`), ...extra });

function setup() {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const mt = new FakeMt();
  const reader = new Reader({ client: mt, store, config: testConfig(), log: () => undefined, now: clock.now, pageDelayMs: 0 });
  return { clock, store, mt, reader };
}

test('refs: usernames, links, ids and invite hashes', () => {
  assert.deepEqual(parseRef('@binance'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('https://t.me/binance/123'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('t.me/s/binance'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('-1001987654321'), { kind: 'id', value: -1001987654321 });
  assert.deepEqual(parseRef('https://t.me/+AbCdEf123_-x'), { kind: 'invite', hash: 'AbCdEf123_-x' });
  assert.deepEqual(parseRef('t.me/joinchat/AbCdEf12'), { kind: 'invite', hash: 'AbCdEf12' });
  assert.deepEqual(parseRef('tg://join?invite=AbCdEf12'), { kind: 'invite', hash: 'AbCdEf12' });
  assert.equal(parseRef('t.me/+'), null);
  assert.equal(parseRef('not a ref!'), null);
  assert.equal(chatIdOf(GROUP), GROUP_ID);
  assert.equal(chatIdOf({ className: 'Chat', id: 4242 }), -4242);
});

test('MTProto messages become stored messages; bots and service messages are skipped', () => {
  const plain = toStored(msg(10, T0, 'hello', { reactions: { results: [{ count: 3 }, { count: 2 }] } }), GROUP_ID)!;
  assert.equal(plain.message.text, 'hello');
  assert.equal(plain.message.reactions, 5);
  assert.equal(plain.author.name, 'user0');

  assert.equal(toStored(msg(11, T0, 'BTC 62000', { sender: user(9, 'PriceBot', { bot: true }) }), GROUP_ID), null);
  assert.equal(toStored({ id: 12, date: T0, className: 'MessageService', action: {} }, GROUP_ID), null);

  const voice = toStored(msg(13, T0, '', { media: { className: 'MessageMediaDocument', document: { attributes: [{ className: 'DocumentAttributeAudio', voice: true, duration: 75 }] } } }), GROUP_ID)!;
  assert.equal(voice.message.text, '[voice 1:15]');
  const sticker = toStored(msg(14, T0, '', { media: { className: 'MessageMediaDocument', document: { attributes: [{ className: 'DocumentAttributeSticker', alt: '😂' }] } } }), GROUP_ID)!;
  assert.equal(sticker.message.text, '[sticker 😂]');
  assert.equal(toStored(msg(15, T0, '', { media: { className: 'MessageMediaContact' } }), GROUP_ID)!.message.text, '[contact]');
  assert.equal(toStored(msg(16, T0, 'x', { media: { className: 'MessageMediaPoll', poll: { question: { text: 'CEX or DEX?' } } } }), GROUP_ID)!.message.text, '[poll: CEX or DEX?] x');

  const fwd = toStored(msg(17, T0, 'news', { fwdFrom: { fromId: { className: 'PeerChannel' } }, forward: { chat: { className: 'Channel', id: 1, title: '链上快讯' } } }), GROUP_ID)!;
  assert.equal(fwd.message.text, '[forwarded from 链上快讯] news');

  const post = toStored(msg(18, T0, 'announcement', { sender: { className: 'Channel', id: 1987654321, title: 'Binance 中文' } }), GROUP_ID)!;
  assert.equal(post.author.id, GROUP_ID);
});

test('forum groups: a message in a topic is not a reply unless it replies inside the topic', () => {
  const inTopic = toStored(msg(20, T0, 'a', { replyTo: { forumTopic: true, replyToMsgId: 7 } }), GROUP_ID)!.message;
  assert.equal(inTopic.replyTo, null);
  assert.equal(inTopic.threadId, 7);
  const replyInTopic = toStored(msg(21, T0, 'b', { replyTo: { forumTopic: true, replyToMsgId: 20, replyToTopId: 7 } }), GROUP_ID)!.message;
  assert.equal(replyInTopic.replyTo, 20);
  assert.equal(replyInTopic.threadId, 7);
  assert.equal(toStored(msg(22, T0, 'c', { replyTo: { replyToMsgId: 20 } }), GROUP_ID)!.message.replyTo, 20);
});

test('the first pull goes back 24 hours, later pulls take only what is new, across pages', async () => {
  const env = setup();
  const info = await env.reader.resolve('https://t.me/binance_cn_test');
  assert.equal(info.chatId, GROUP_ID);
  assert.equal(info.type, 'supergroup');
  assert.equal(info.members, 120_000);
  const chat = env.store.watchChat(info, 42, null, { language: 'auto', digestHour: 9, timezone: 'Asia/Shanghai', rsiMode: 'auto' });

  // 30 old messages (2 days ago) and 250 from the last 24 hours.
  for (let i = 1; i <= 30; i++) env.mt.messages.push(msg(i, T0 - 2 * 86_400 + i, `old ${i}`));
  for (let i = 31; i <= 280; i++) env.mt.messages.push(msg(i, T0 - 86_000 + i * 60, `new ${i}`));
  assert.equal(await env.reader.pull(chat), 250);
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 280);
  assert.equal(env.store.countMessages(GROUP_ID, 0, T0 * 2), 250);
  assert.equal(env.mt.historyCalls, 4, 'one lookup of where 24 hours ago is, then three pages of 100, oldest first');

  env.mt.messages.push(msg(281, T0 + 60, 'later'), msg(282, T0 + 120, 'later still'));
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 2);
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 282);
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 0);
});

test('messages posted while the service was offline come in when it is back, with their own timestamps', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 10; i++) env.mt.messages.push(msg(i, T0 - 3600 + i, `before ${i}`));
  assert.equal(await env.reader.pull(chat), 10);

  // The service stops (a laptop asleep overnight); 350 messages are posted over 9 hours.
  for (let i = 11; i <= 360; i++) env.mt.messages.push(msg(i, T0 + (i - 10) * 90, `while offline ${i}`));
  env.clock.t = T0 + 10 * 3600;
  // It comes back as a new process: a new Reader, same database.
  const events: { method: string; detail: string }[] = [];
  const activity = { event: (_actor: string, method: string, _target: string, detail: string) => events.push({ method, detail }) } as never;
  const back = new Reader({ client: env.mt, store: env.store, config: testConfig(), log: () => undefined, now: env.clock.now, pageDelayMs: 0, activity });
  assert.equal(await back.pull(env.store.getChat(GROUP_ID)!), 350);
  const recovered = events.find((e) => e.method === 'recovered');
  assert.ok(recovered, 'the recovery is reported');
  assert.match(recovered.detail, /^350 messages posted while it was not reading .*600 min\), now stored; up to date$/);
  const stored = env.store.messages(GROUP_ID, 0, T0 * 2);
  assert.equal(stored.length, 360);
  assert.deepEqual(stored.map((m) => m.messageId), Array.from({ length: 360 }, (_, i) => i + 1), 'no gap');
  assert.equal(stored[10].date, T0 + 90, 'kept the time it was posted, not the time it was fetched');
  assert.equal(back.isBehind(GROUP_ID), false);
});

test('a pull cut short resumes exactly where it stopped: a dropped connection or the page cap never leaves a gap', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 450; i++) env.mt.messages.push(msg(i, T0 - 7200 + i, `m ${i}`));
  env.mt.failOnCall = 4; // the date lookup, two pages, then the connection drops
  await assert.rejects(env.reader.pull(chat), /Connection closed/);
  assert.equal(env.store.countMessages(GROUP_ID, 0, T0 * 2), 200, 'the pages before the drop are kept');
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 200);
  env.mt.failOnCall = 0;
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 250);
  assert.equal(env.store.countMessages(GROUP_ID, 0, T0 * 2), 450);

  // More than one pull's worth (100 pages): the first stops at the cap and says it is behind.
  for (let i = 451; i <= 10_550; i++) env.mt.messages.push(msg(i, T0 - 3600 + i / 10, `burst ${i}`));
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 10_000);
  assert.equal(env.reader.isBehind(GROUP_ID), true);
  assert.equal(await env.reader.catchUp(env.store.getChat(GROUP_ID)!), true);
  assert.equal(env.store.countMessages(GROUP_ID, 0, T0 * 2), 10_550);
});

test('two pulls at once neither store twice nor move the cursor backwards', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 230; i++) env.mt.messages.push(msg(i, T0 - 3600 + i, `m ${i}`));
  const [a, b] = await Promise.all([env.reader.pull(chat), env.reader.pull(chat)]);
  assert.equal(a + b, 230);
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 230);
});

test('offline for longer than the retention period: it starts from the retention floor, not from the old cursor', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  env.mt.messages.push(msg(1, T0 - 60, 'last seen'));
  await env.reader.pull(chat);
  // 10 days offline (retention is 7): one message a day.
  for (let d = 1; d <= 10; d++) env.mt.messages.push(msg(1 + d, T0 + d * 86_400 - 3600, `day ${d}`));
  env.clock.t = T0 + 10 * 86_400;
  await env.reader.pull(env.store.getChat(GROUP_ID)!);
  const days = env.store.messages(GROUP_ID, 0, T0 * 2).map((m) => m.text);
  assert.deepEqual(days, ['last seen', 'day 4', 'day 5', 'day 6', 'day 7', 'day 8', 'day 9', 'day 10']);
});

test('the audit checks the capture against Telegram: every message is stored or skipped for a reason', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 120; i++) env.mt.messages.push(msg(i, T0 - 3000 + i * 10, `m ${i}`));
  env.mt.messages.push(msg(121, T0 - 500, 'BTC 62000', { sender: user(9, 'PriceBot', { bot: true }) }));
  env.mt.messages.push({ id: 122, date: T0 - 400, className: 'MessageService', action: {} });
  await env.reader.pull(chat);
  env.store.db.exec(`DELETE FROM messages WHERE message_id = 50`); // pretend one was lost
  env.mt.messages.push(msg(123, T0 + 10, 'after the last pull'));
  env.clock.t = T0 + 20;
  const r = await env.reader.audit(env.store.getChat(GROUP_ID)!, T0 - 3600);
  assert.deepEqual(r, { checked: 122, stored: 119, bots: 1, service: 1, empty: 0, missing: [50], newerThanCursor: 1 });
});

test('the watchdog: a pull that hangs (dead connection) triggers a reconnect, and reading resumes', async () => {
  const env = setup();
  env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 5; i++) env.mt.messages.push(msg(i, T0 - 600 + i, `m ${i}`));
  let dead = true;
  const real = env.mt.getMessages.bind(env.mt);
  env.mt.getMessages = (e, p) => (dead ? new Promise(() => undefined) : real(e, p)); // hangs forever while "dead"
  let reconnects = 0;
  const events: string[] = [];
  const reader = new Reader({
    client: env.mt,
    store: env.store,
    config: { ...testConfig(), readerPollSeconds: 30 },
    log: () => undefined,
    now: env.clock.now,
    pageDelayMs: 0,
    pullTimeoutMs: 50,
    activity: { event: (_a: string, method: string) => events.push(method) } as never,
    reconnect: async () => {
      reconnects++;
      dead = false;
    },
  });
  const stop = reader.start();
  for (let i = 0; i < 100 && env.store.countMessages(GROUP_ID, 0, T0 * 2) < 5; i++) await new Promise((r) => setTimeout(r, 100));
  stop();
  assert.equal(reconnects, 1);
  assert.ok(events.includes('pull failed'));
  assert.equal(env.store.countMessages(GROUP_ID, 0, T0 * 2), 5, 'read again after the reconnect');
});

test('after a gap, one line sums up what came back; only chats that got messages get their own line', async () => {
  const env = setup();
  const quiet: MtEntity = { className: 'Channel', id: 777, title: 'Quiet channel', username: 'quiet_test', broadcast: true };
  env.mt.entities.set('quiet_test', quiet);
  env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  env.store.watchChat(await env.reader.resolve('@quiet_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (const id of [GROUP_ID, -1000000000777]) {
    env.store.updateChat(id, { readerCursor: 0 });
    env.store.setKv(`reader_caught_up:${id}`, String(T0 - 3600)); // last caught up an hour ago
    env.store.setKv(`reader_cursor_date:${id}`, String(T0 - 3600));
  }
  for (let i = 1; i <= 3; i++) env.mt.messages.push(msg(i, T0 - 1800 + i, `while away ${i}`));
  // The fake holds one chat's history; the quiet channel has none.
  const real = env.mt.getMessages.bind(env.mt);
  env.mt.getMessages = (e, p) => (e.id === 777 ? Promise.resolve([]) : real(e, p));
  const events: { method: string; target: string; detail: string }[] = [];
  const activity = { event: (_a: string, method: string, target: string, detail: string) => events.push({ method, target, detail }) } as never;
  const reader = new Reader({ client: env.mt, store: env.store, config: testConfig(), log: () => undefined, now: env.clock.now, pageDelayMs: 0, activity });
  const stop = reader.start();
  for (let i = 0; i < 50 && !events.some((e) => e.target === 'all sources'); i++) await new Promise((r) => setTimeout(r, 20));
  stop();
  const recovered = events.filter((e) => e.method === 'recovered');
  assert.deepEqual(recovered.map((e) => e.target), ['Binance 中文', 'all sources']);
  assert.match(recovered[0].detail, /^3 messages posted while it was not reading .*60 min\), now stored; up to date$/);
  assert.equal(recovered[1].detail, 'back after 60 min: 3 messages recovered across 1 chat; 1 had nothing new; everything is up to date');
});

test('a group silent for a day still moves the cursor, so old history is not re-read', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  for (let i = 1; i <= 5; i++) env.mt.messages.push(msg(i, T0 - 3 * 86_400, `old ${i}`));
  assert.equal(await env.reader.pull(chat), 0);
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 5);
});

test('refresh brings in reaction counts and edits before a digest', async () => {
  const env = setup();
  const chat = env.store.watchChat(await env.reader.resolve('@binance_cn_test'), 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  env.mt.messages.push(msg(1, T0 - 600, 'first draft'));
  await env.reader.pull(chat);
  env.mt.messages[0] = msg(1, T0 - 600, 'final text', { editDate: T0, reactions: { results: [{ count: 9 }] } });
  await env.reader.refresh(env.store.getChat(GROUP_ID)!, { start: T0 - 86_400, end: T0 + 1 });
  const [m] = env.store.messages(GROUP_ID, 0, T0 * 2);
  assert.equal(m.text, 'final text');
  assert.equal(m.reactions, 9);
});

test('a private group the reader account joined is found by its name, and by id after a restart', async () => {
  const env = setup();
  const vip: MtEntity = { className: 'Channel', id: 3333333333, title: 'Alpha VIP 内部群', megagroup: true };
  env.mt.dialogs.push({ entity: vip, title: 'Alpha VIP 内部群' }, { entity: { className: 'Channel', id: 4444444444, title: 'Alpha 公告', broadcast: true }, title: 'Alpha 公告' });

  const info = await env.reader.resolve('alpha vip');
  assert.equal(info.chatId, -1003333333333);
  assert.equal(info.ref, '-1003333333333');
  await assert.rejects(env.reader.resolve('alpha'), /several of the reader account's chats match "alpha": Alpha VIP 内部群 · Alpha 公告/);
  await assert.rejects(env.reader.resolve('no such group'), /has joined no group or channel with that name/);
  await assert.rejects(env.reader.resolve('A friend'), /has joined no group or channel/);

  // A fresh reader (the process restarted): the id is unknown until the chat list is loaded.
  const fresh = new FakeMt();
  fresh.dialogs = env.mt.dialogs;
  fresh.messages.push(msg(1, T0 - 600, '内部消息'));
  const reader = new Reader({ client: fresh, store: env.store, config: testConfig(), log: () => undefined, now: env.clock.now, pageDelayMs: 0 });
  const chat = env.store.watchChat(info, 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  assert.equal(await reader.pull(chat), 1);
});

test('Telegram errors become reasons a person can act on', async () => {
  const env = setup();
  await assert.rejects(env.reader.resolve('@nobody_here'), /no public group or channel has that username/);
  await assert.rejects(env.reader.resolve('https://t.me/+AbCdEfGh1234'), /join the group with the reader account/);
  env.mt.entities.set('someone', user(77, 'Someone'));
  await assert.rejects(env.reader.resolve('@someone'), /a person, not a group/);
  assert.match(explain({ errorMessage: 'CHANNEL_PRIVATE' }).message, /PUBLIC group this usually means the account was banned/);
  assert.match(explain({ errorMessage: 'FROZEN_METHOD_INVALID' }).message, /FROZEN/);
  assert.match(explain({ errorMessage: 'USER_DEACTIVATED_BAN' }).message, /BANNED.*appeal/);
  assert.match(explain({ errorMessage: 'USER_DEACTIVATED' }).message, /npm run login/);
  assert.match(explain({ errorMessage: 'AUTH_KEY_DUPLICATED' }).message, /two processes/);
  assert.match(explain({ errorMessage: 'PEER_FLOOD' }).message, /limited/);
  assert.equal(explain({ errorMessage: 'FLOOD_WAIT_42', seconds: 42 }).retryAfter, 42);
  assert.match(explain({ errorMessage: 'AUTH_KEY_UNREGISTERED' }).message, /npm run login/);
});
