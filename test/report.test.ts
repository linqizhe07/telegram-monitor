import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PulseBot, type ReaderLike } from '../src/bot.ts';
import type { Config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { FakeLlm } from '../src/fake-llm.ts';
import type { SourceInfo } from '../src/reader.ts';
import { startScheduler } from '../src/scheduler.ts';
import type { TgUpdate } from '../src/telegram.ts';
import { Clock, FakeTelegram, groupMessage, memoryStore, seedUsers, syntheticDay, T0, testConfig } from './helpers.ts';

const OWNER = 1001;
const BINANCE: SourceInfo = { chatId: -1001111111111, title: 'Binance 中文', username: 'binance_cn_test', type: 'supergroup', ref: '@binance_cn_test', members: 120_000, peer: null };
const OKX: SourceInfo = { chatId: -1002222222222, title: 'OKX 中文', username: 'okx_cn_test', type: 'supergroup', ref: '@okx_cn_test', members: 80_000, peer: null };

/** Stands in for the reader account: resolves known usernames, and "pulls" a day of chat into the store. */
class FakeReader implements ReaderLike {
  pulls: number[] = [];
  private readonly env: { store: ReturnType<typeof memoryStore> };
  constructor(env: { store: ReturnType<typeof memoryStore> }) {
    this.env = env;
  }
  async resolve(input: string): Promise<SourceInfo> {
    const name = input.replace(/^@|^https?:\/\/t\.me\//, '').toLowerCase();
    const hit = [BINANCE, OKX].find((s) => s.username === name);
    if (!hit) throw new Error('no public group or channel has that username');
    return hit;
  }
  async pullNow(chatId: number): Promise<number> {
    this.pulls.push(chatId);
    seedUsers(this.env.store, chatId);
    const day = syntheticDay(chatId, T0 - 20 * 3600, 100, 6);
    for (const m of day) this.env.store.saveMessage(m);
    return day.length;
  }
}

async function setup(over: Partial<Config> = {}) {
  const clock = new Clock(T0 + 3600);
  const store = memoryStore(clock);
  const api = new FakeTelegram();
  const config = testConfig({ ownerIds: [OWNER], ...over });
  const engine = new Engine({ store, llm: new FakeLlm(), config, api, now: clock.now, log: () => undefined });
  const reader = new FakeReader({ store });
  const bot = new PulseBot({ store, engine, api, config, me: await api.getMe(), now: clock.now, log: () => undefined, reader });
  return { clock, store, api, config, engine, reader, bot };
}

let id = 1;
const dm = (text: string, from = OWNER, extra: Record<string, unknown> = {}): TgUpdate => ({
  update_id: id++,
  message: { message_id: id++, date: T0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'Zhe', language_code: 'zh-hans' } as never, text, ...extra },
});

test('the owner watches a public group from a DM; its digest, votes and replies all live in the DM', async () => {
  const env = await setup();
  await env.bot.handle(dm('/watch https://t.me/binance_cn_test'));
  const watched = env.store.getChat(BINANCE.chatId)!;
  assert.equal(watched.kind, 'watched');
  assert.equal(watched.reportChatId, OWNER);
  assert.equal(env.store.getChat(OWNER)!.kind, 'report');
  assert.deepEqual(env.reader.pulls, [BINANCE.chatId]);
  assert.match(env.api.sent.at(-2)!.text, /开始监控 <b>Binance 中文<\/b>（群，120,000 人，@binance_cn_test）/);
  assert.match(env.api.last().text, /已读取最近 24 小时的 28 条消息/);

  // /digest in the DM: one watched group, so no name needed. It is posted in the DM.
  await env.bot.handle(dm('/digest'));
  await env.engine.idle();
  const post = env.api.last();
  assert.equal(post.chatId, OWNER);
  assert.match(post.text, /📡 Binance 中文/);
  const digestId = Number(/^v:(\d+):1$/.exec(post.opts.keyboard![0][0].callback_data)![1]);
  const digest = env.store.digest(digestId)!;
  assert.equal(digest.chatId, BINANCE.chatId);
  assert.equal(digest.postedChatId, OWNER);

  // A vote in the DM counts for the watched group.
  await env.bot.handle({ update_id: id++, callback_query: { id: 'cb', from: { id: OWNER, is_bot: false, first_name: 'Zhe' }, message: { message_id: post.id, date: T0, chat: { id: OWNER, type: 'private' } }, data: `v:${digestId}:-1` } });
  assert.deepEqual(env.store.tally(digestId), { up: 0, down: 1 });

  // So does a reply to the digest.
  await env.bot.handle(dm('痛点写得太泛了', OWNER, { reply_to_message: { message_id: post.id, date: T0, chat: { id: OWNER, type: 'private' }, from: { id: 42, is_bot: true, first_name: 'Pulse' } } }));
  assert.equal(env.store.feedbackSince(BINANCE.chatId, 0)[0].text, '痛点写得太泛了');
  assert.equal(env.store.feedbackSince(OWNER, 0).length, 0);
});

test('only owners can watch; anyone else gets their user id and nothing more', async () => {
  const env = await setup();
  await env.bot.handle(dm('/watch @binance_cn_test', 777));
  assert.match(env.api.last().text, /你的 Telegram 用户 id 是 <code>777<\/code>/);
  assert.equal(env.store.getChat(BINANCE.chatId), null);
  await env.bot.handle(groupMessage({ id: 5, from: { id: 777, first_name: 'Momo' }, text: '/watch @binance_cn_test' }));
  assert.match(env.api.last().text, /Only the owner|只有这个 Pulse 的部署者/);
});

test('a report chat with several watched groups asks which one, and accepts @name or #n', async () => {
  const env = await setup();
  await env.bot.handle(dm('/watch @binance_cn_test'));
  await env.bot.handle(dm('/watch @okx_cn_test'));
  assert.equal(env.store.sourcesReportingTo(OWNER).length, 2);

  await env.bot.handle(dm('/digest'));
  assert.match(env.api.last().text, /哪个群？[\s\S]*#1 Binance 中文 \(@binance_cn_test\)\n#2 OKX 中文 \(@okx_cn_test\)/);

  await env.bot.handle(dm('/digest #2 24'));
  await env.engine.idle();
  assert.match(env.api.last().text, /📡 OKX 中文/);

  await env.bot.handle(dm('/sources'));
  assert.match(env.api.last().text, /#1 Binance 中文（@binance_cn_test）· 近 24 小时 28 条/);

  await env.bot.handle(dm('/unwatch @okx_cn_test'));
  assert.equal(env.store.getChat(OKX.chatId)!.enabled, false);
  assert.equal(env.store.sourcesReportingTo(OWNER).length, 1);
});

test('watching from a group turns it into a report group: its own chatter is no longer recorded', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: OWNER, first_name: 'Zhe' }, text: '团队群日常' }));
  assert.equal(env.store.countMessages(-1001234567890, 0, T0 * 2), 1);
  await env.bot.handle(groupMessage({ id: 2, from: { id: OWNER, first_name: 'Zhe' }, text: '/watch @binance_cn_test' }));
  assert.equal(env.store.getChat(-1001234567890)!.kind, 'report');
  assert.match(env.api.sent.find((s) => s.text.includes('开始监控') || s.text.includes('Watching'))!.text, /report chat|报告群/);
  await env.bot.handle(groupMessage({ id: 3, from: { id: 5, first_name: 'Momo' }, text: '这条不该被记录' }));
  assert.equal(env.store.countMessages(-1001234567890, 0, T0 * 2), 1);
  assert.equal(env.store.getChat(BINANCE.chatId)!.reportChatId, -1001234567890);
});

test('scheduled digests of watched groups go to the report chat; report chats themselves are never digested', async () => {
  const env = await setup();
  await env.bot.handle(dm('/watch @binance_cn_test'));
  env.store.updateChat(BINANCE.chatId, { lastDigestAt: T0 - 86_400 - 60 });
  env.store.updateChat(OWNER, { lastDigestAt: 0 });
  const before = env.api.sent.length;
  const stop = startScheduler(env.engine, env.store, { now: env.clock.now, log: () => undefined, intervalMs: 3_600_000 });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  await env.engine.idle();
  await env.engine.idle();
  const after = env.api.sent.slice(before);
  assert.ok(after.length >= 1);
  assert.ok(after.every((s) => s.chatId === OWNER), 'everything goes to the DM, nothing to the watched group');
  assert.ok(after.some((s) => s.text.includes('📡 Binance 中文')));
  assert.equal(env.store.productionDigests(OWNER, 5).length, 0);
});

test('without a reader account, /watch explains how to set one up', async () => {
  const env = await setup();
  const bot = new PulseBot({ store: env.store, engine: env.engine, api: env.api, config: env.config, me: await env.api.getMe(), now: env.clock.now, log: () => undefined, reader: null });
  await bot.handle(dm('/watch @binance_cn_test'));
  assert.match(env.api.last().text, /npm run login/);
});
