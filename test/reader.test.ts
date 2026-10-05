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
  async getEntity(ref: string | number): Promise<MtEntity> {
    const e = this.entities.get(ref);
    if (!e) throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
    return e;
  }
  async getDialogs(): Promise<{ entity?: MtEntity; title?: string }[]> {
    for (const d of this.dialogs) this.entities.set(chatIdOf(d.entity), d.entity);
    return [...this.dialogs, { entity: user(1, 'A friend'), title: 'A friend' }];
  }
  async getMessages(_e: MtEntity, p: { limit?: number; offsetId?: number; minId?: number; ids?: number[] }) {
    if (p.ids) return p.ids.map((id) => this.messages.find((m) => m.id === id));
    this.historyCalls++;
    return this.messages
      .filter((m) => m.id > (p.minId ?? 0) && (!p.offsetId || m.id < p.offsetId))
      .sort((a, b) => b.id - a.id)
      .slice(0, p.limit ?? 100);
  }
}

const user = (id: number, firstName: string, extra: Partial<MtEntity> = {}): MtEntity => ({ className: 'User', id, firstName, ...extra });
const msg = (id: number, date: number, text: string, extra: Partial<MtMessage> = {}): MtMessage => ({ id, date, message: text, sender: user(500 + (id % 5), `user${id % 5}`), ...extra });

function setup() {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const mt = new FakeMt();
  const reader = new Reader({ client: mt, store, config: testConfig(), log: () => undefined, now: clock.now });
  return { clock, store, mt, reader };
}

test('refs: usernames, links, ids; invite links are refused', () => {
  assert.deepEqual(parseRef('@binance'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('https://t.me/binance/123'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('t.me/s/binance'), { kind: 'username', value: 'binance' });
  assert.deepEqual(parseRef('-1001987654321'), { kind: 'id', value: -1001987654321 });
  assert.deepEqual(parseRef('https://t.me/+AbCdEf123'), { kind: 'invite' });
  assert.deepEqual(parseRef('t.me/joinchat/AbCdEf'), { kind: 'invite' });
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
  assert.equal(env.mt.historyCalls, 3, 'three pages of 100');

  env.mt.messages.push(msg(281, T0 + 60, 'later'), msg(282, T0 + 120, 'later still'));
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 2);
  assert.equal(env.store.getChat(GROUP_ID)!.readerCursor, 282);
  assert.equal(await env.reader.pull(env.store.getChat(GROUP_ID)!), 0);
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
  const reader = new Reader({ client: fresh, store: env.store, config: testConfig(), log: () => undefined, now: env.clock.now });
  const chat = env.store.watchChat(info, 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  assert.equal(await reader.pull(chat), 1);
});

test('Telegram errors become reasons a person can act on', async () => {
  const env = setup();
  await assert.rejects(env.reader.resolve('@nobody_here'), /no public group or channel has that username/);
  await assert.rejects(env.reader.resolve('https://t.me/+secret'), /join the group with the reader account/);
  env.mt.entities.set('someone', user(77, 'Someone'));
  await assert.rejects(env.reader.resolve('@someone'), /a person, not a group/);
  assert.match(explain({ errorMessage: 'CHANNEL_PRIVATE' }).message, /join it first/);
  assert.equal(explain({ errorMessage: 'FLOOD_WAIT_42', seconds: 42 }).retryAfter, 42);
  assert.match(explain({ errorMessage: 'AUTH_KEY_UNREGISTERED' }).message, /npm run login/);
});
