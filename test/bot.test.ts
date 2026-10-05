import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeMessage, parseCommand, PulseBot } from '../src/bot.ts';
import type { Config } from '../src/config.ts';
import { Engine } from '../src/engine.ts';
import { FakeLlm } from '../src/fake-llm.ts';
import { startScheduler } from '../src/scheduler.ts';
import type { TgUpdate, TgUser } from '../src/telegram.ts';
import { lastSlot } from '../src/transcript.ts';
import { CHAT, Clock, FakeTelegram, groupMessage, memoryStore, seedUsers, syntheticDay, T0, testConfig } from './helpers.ts';

async function setup(over: Partial<Config> = {}, me: Partial<TgUser> = {}) {
  const clock = new Clock(T0 + 3600);
  const store = memoryStore(clock);
  const api = new FakeTelegram();
  const config = testConfig(over);
  const llm = new FakeLlm();
  const log = () => undefined;
  const engine = new Engine({ store, llm, config, api, now: clock.now, log });
  const bot = new PulseBot({ store, engine, api, config, me: { ...(await api.getMe()), ...me }, now: clock.now, log });
  return { clock, store, api, config, llm, engine, bot };
}

const added = (fromId: number): TgUpdate => ({
  update_id: 1,
  my_chat_member: {
    chat: { id: CHAT, type: 'supergroup', title: 'Alpha Builders 研究群' },
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
    date: T0,
    old_chat_member: { status: 'left', user: { id: 42, is_bot: true, first_name: 'Pulse' } },
    new_chat_member: { status: 'member', user: { id: 42, is_bot: true, first_name: 'Pulse' } },
  },
});

test('commands: own, other bots, arguments', () => {
  assert.deepEqual(parseCommand('/digest 12', 'pulse_bot'), { name: 'digest', args: '12', forOther: false });
  assert.deepEqual(parseCommand('/digest@Pulse_Bot', 'pulse_bot'), { name: 'digest', args: '', forOther: false });
  assert.equal(parseCommand('/digest@other_bot', 'pulse_bot')!.forOther, true);
  assert.equal(parseCommand('not a command', 'pulse_bot'), null);
});

test('messages become one line; media is tagged, contacts and locations are not copied', () => {
  const base = { message_id: 1, date: 0, chat: { id: CHAT, type: 'supergroup' as const } };
  assert.equal(describeMessage({ ...base, photo: [{}], caption: '看这个价差' }), '[photo] 看这个价差');
  assert.equal(describeMessage({ ...base, voice: { duration: 75 } }), '[voice 1:15]');
  assert.equal(describeMessage({ ...base, contact: {} }), '[contact]');
  assert.equal(describeMessage({ ...base, forward_origin: { type: 'channel', chat: { id: -1, type: 'channel', title: '链上快讯' } }, text: 'x' }), '[forwarded from 链上快讯] x');
  assert.equal(describeMessage({ ...base, forward_origin: { type: 'user', sender_user: { id: 9, is_bot: false, first_name: 'Third Party' } }, text: 'x' }), '[forwarded] x');
  assert.equal(describeMessage({ ...base, new_chat_members: [] }), null);
});

test('joining a group: intro, and a warning while privacy mode hides messages', async () => {
  const env = await setup({}, { can_read_all_group_messages: false });
  await env.bot.handle(added(5));
  assert.equal(env.api.sent.length, 2);
  assert.match(env.api.sent[0].text, /Pulse 来了/);
  assert.match(env.api.sent[1].text, /setprivacy/);
  assert.equal(env.store.getChat(CHAT)!.enabled, true);
});

test('a private instance leaves groups its owners did not add it to', async () => {
  const env = await setup({ ownerIds: [99] });
  await env.bot.handle(added(5));
  assert.deepEqual(env.api.left, [CHAT]);
  assert.equal(env.store.getChat(CHAT), null);
  await env.bot.handle(added(99));
  assert.equal(env.store.getChat(CHAT)!.enabled, true);
});

test('records members with stable aliases; skips bots, commands and opted-out members', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 7, first_name: '老王' }, text: 'gm 各位' }));
  await env.bot.handle(groupMessage({ id: 2, from: { id: 8, first_name: 'Kevin', username: 'kev' }, text: '周末美股价格又偏了' }));
  await env.bot.handle(groupMessage({ id: 3, from: { id: 9, is_bot: true, first_name: 'PriceAlertBot' }, text: 'BTC 62000' }));
  await env.bot.handle(groupMessage({ id: 4, from: { id: 8, first_name: 'Kevin' }, text: '/digest@other_bot' }));
  await env.bot.handle(groupMessage({ id: 5, from: { id: 7, first_name: '老王' }, extra: { photo: [{}], caption: '截图' } }));

  const stored = env.store.messages(CHAT, 0, T0 * 2);
  assert.deepEqual(stored.map((m) => m.messageId), [1, 2, 5]);
  assert.equal(stored[2].text, '[photo] 截图');
  const users = env.store.users(CHAT);
  assert.equal(users.get(7)!.alias, 'U1');
  assert.equal(users.get(8)!.alias, 'U2');

  await env.bot.handle(groupMessage({ id: 6, from: { id: 8, first_name: 'Kevin' }, text: '/optout' }));
  assert.match(env.api.last().text, /已存的 1 条也删了/);
  await env.bot.handle(groupMessage({ id: 7, from: { id: 8, first_name: 'Kevin' }, text: '不该被记录' }));
  assert.deepEqual(env.store.messages(CHAT, 0, T0 * 2).map((m) => m.messageId), [1, 5]);
  await env.bot.handle(groupMessage({ id: 8, from: { id: 8, first_name: 'Kevin' }, text: '/optin' }));
  await env.bot.handle(groupMessage({ id: 9, from: { id: 8, first_name: 'Kevin' }, text: '回来了' }));
  assert.deepEqual(env.store.messages(CHAT, 0, T0 * 2).map((m) => m.messageId), [1, 5, 9]);

  await env.bot.handle({ update_id: 99, edited_message: { message_id: 9, date: T0, chat: { id: CHAT, type: 'supergroup' }, from: { id: 8, is_bot: false, first_name: 'Kevin' }, text: '回来了（改）' } });
  assert.equal(env.store.messages(CHAT, 0, T0 * 2).at(-1)!.text, '回来了（改）');
});

test('/digest posts a digest with vote buttons; votes toggle; replies to it become feedback', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 1, first_name: '老王' }, text: 'gm', date: T0 }));
  seedUsers(env.store, CHAT);
  for (const m of syntheticDay(CHAT, T0 - 20 * 3600, 100, 5)) env.store.saveMessage(m);

  await env.bot.handle(groupMessage({ id: 500, from: { id: 3, first_name: '阿杰' }, text: '/digest' }));
  assert.deepEqual(env.api.reactions.at(-1), { chatId: CHAT, messageId: 500, emoji: '👀' });
  await env.engine.idle();
  const post = env.api.last();
  assert.match(post.text, /🧭 话题/);
  assert.equal(post.opts.replyTo, 500);
  const digestId = Number(/^v:(\d+):1$/.exec(post.opts.keyboard![0][0].callback_data)![1]);
  assert.deepEqual(env.store.digest(digestId)!.postedIds, [post.id]);
  assert.equal(env.store.messages(CHAT, 0, T0 * 2).some((m) => m.messageId === 500), false, 'commands are not conversation');

  const vote = (userId: number, value: string): TgUpdate => ({
    update_id: 1,
    callback_query: { id: `cb${userId}`, from: { id: userId, is_bot: false, first_name: 'x' }, message: { message_id: post.id, date: T0, chat: { id: CHAT, type: 'supergroup' } }, data: `v:${digestId}:${value}` },
  });
  await env.bot.handle(vote(11, '1'));
  assert.equal(env.api.keyboards.at(-1)!.keyboard[0][0].text, '👍 有用 · 1');
  assert.equal(env.api.answers.at(-1)!.text, '收到！投票会影响摘要怎么改进自己。');
  await env.bot.handle(vote(11, '1'));
  assert.equal(env.api.keyboards.at(-1)!.keyboard[0][0].text, '👍 有用');
  await env.bot.handle(vote(12, '-1'));
  assert.deepEqual(env.store.tally(digestId), { up: 0, down: 1 });

  const before = env.store.messages(CHAT, 0, T0 * 2).length;
  await env.bot.handle(
    groupMessage({
      id: 600,
      from: { id: 4, first_name: 'Momo' },
      text: '把没人回答的问题也列出来',
      replyTo: { message_id: post.id, date: T0, chat: { id: CHAT, type: 'supergroup' }, from: { id: 42, is_bot: true, first_name: 'Pulse' } },
    }),
  );
  assert.equal(env.store.feedbackSince(CHAT, 0)[0].text, '把没人回答的问题也列出来');
  assert.equal(env.store.messages(CHAT, 0, T0 * 2).length, before);
  assert.deepEqual(env.api.reactions.at(-1), { chatId: CHAT, messageId: 600, emoji: '✍' });
});

test('settings are for admins', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 7, first_name: 'Momo' }, text: '/settings hour 21' }));
  assert.match(env.api.last().text, /Only group admins|只有群管理员/);
  env.api.statuses.set(`${CHAT}:8`, 'administrator');
  await env.bot.handle(groupMessage({ id: 2, from: { id: 8, first_name: 'Admin' }, text: '/settings hour 21' }));
  await env.bot.handle(groupMessage({ id: 3, from: { id: 8, first_name: 'Admin' }, text: '/settings tz Europe/London' }));
  await env.bot.handle(groupMessage({ id: 4, from: { id: 8, first_name: 'Admin' }, text: '/settings tz Mars/Olympus' }));
  const chat = env.store.getChat(CHAT)!;
  assert.equal(chat.digestHour, 21);
  assert.equal(chat.timezone, 'Europe/London');
  assert.match(env.api.last().text, /Did not understand|没看懂/);
});

test('the scheduler posts each daily digest once, then runs a self-improvement round', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 1, first_name: '老王' }, text: 'gm', date: T0 - 2 * 86_400 }));
  env.store.updateChat(CHAT, { lastDigestAt: T0 - 86_400 - 60 });
  seedUsers(env.store, CHAT);
  for (const m of syntheticDay(CHAT, T0 - 86_400, 100, 6)) env.store.saveMessage(m);

  const stop = startScheduler(env.engine, env.store, { now: env.clock.now, log: () => undefined, intervalMs: 3_600_000 });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  await env.engine.idle();
  await env.engine.idle();

  const slot = lastSlot(env.clock.t, 'Asia/Shanghai', 9);
  assert.equal(slot, T0);
  assert.equal(env.store.getChat(CHAT)!.lastDigestAt, T0);
  const texts = env.api.sent.map((s) => s.text);
  assert.ok(texts.some((t) => t.includes('🧭 话题')), 'digest posted');
  assert.ok(texts.some((t) => t.includes('Pulse 改写了自己的 playbook：v0 → v1')), 'adoption announced');
  assert.equal(env.store.productionDigests(CHAT, 5).length, 1);

  // A second tick in the same slot does nothing.
  const sent = env.api.sent.length;
  const stop2 = startScheduler(env.engine, env.store, { now: env.clock.now, log: () => undefined, intervalMs: 3_600_000 });
  stop2();
  await env.engine.idle();
  assert.equal(env.api.sent.length, sent);
});

test('model-written text is escaped before it reaches Telegram HTML', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 1, first_name: '老王' }, text: 'gm', date: T0 - 2 * 86_400 }));
  seedUsers(env.store, CHAT);
  for (const m of syntheticDay(CHAT, T0 - 86_400, 100, 6)) env.store.saveMessage(m);
  const llm = new FakeLlm({
    improve: () => ({
      improver_notes: 'n',
      candidates: [{ operator: 'repair', rationale: 'cover <b>more</b> & better', playbook: 'What goes in each section: everything.\n- Cover at least 6 conversations.\n- Be specific about numbers and stakes.' }],
    }),
  });
  const engine = new Engine({ store: env.store, llm, config: env.config, api: env.api, now: env.clock.now, log: () => undefined });
  await engine.scheduled(CHAT, T0);
  const announcement = env.api.sent.map((s) => s.text).find((t) => t.includes('v0 → v1'))!;
  assert.ok(announcement.includes('cover &lt;b&gt;more&lt;/b&gt; &amp; better'));
});

test('/rsi shows the lineage, the votes and the improver\'s own notes; evolve and rollback are for admins', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 1, first_name: '老王' }, text: 'gm', date: T0 - 2 * 86_400 }));
  seedUsers(env.store, CHAT);
  for (const m of syntheticDay(CHAT, T0 - 86_400, 100, 6)) env.store.saveMessage(m);
  await env.engine.scheduled(CHAT, T0);

  await env.bot.handle(groupMessage({ id: 700, from: { id: 5, first_name: 'Ivy' }, text: '/rsi' }));
  const status = env.api.last().text;
  assert.match(status, /当前 playbook v1/);
  assert.match(status, /✓ v1 \[repair\] judge 100%/);
  assert.match(status, /✗ v2 \[simplify\]/);
  assert.match(status, /改进者的策略笔记/);
  assert.match(status, /<blockquote expandable>After 0 earlier proposal/);

  await env.bot.handle(groupMessage({ id: 701, from: { id: 5, first_name: 'Ivy' }, text: '/rsi playbook' }));
  assert.match(env.api.last().text, /playbook v1<\/b>\n<blockquote expandable>What goes in each section/);

  await env.bot.handle(groupMessage({ id: 702, from: { id: 5, first_name: 'Ivy' }, text: '/rsi rollback' }));
  assert.match(env.api.last().text, /只有群管理员/);
  env.api.statuses.set(`${CHAT}:5`, 'creator');
  env.clock.t += 61; // a "not an admin" answer is only cached for a minute
  await env.bot.handle(groupMessage({ id: 703, from: { id: 5, first_name: 'Ivy' }, text: '/rsi rollback' }));
  assert.match(env.api.last().text, /从 playbook v1 回退到 v0/);
  assert.equal(env.store.genome(CHAT, 1)!.status, 'vetoed');
});

test('quiet days post nothing', async () => {
  const env = await setup();
  await env.bot.handle(groupMessage({ id: 1, from: { id: 1, first_name: '老王' }, text: 'gm', date: T0 - 3600 }));
  await env.engine.scheduled(CHAT, T0);
  assert.equal(env.api.sent.length, 0);
  assert.equal(env.store.getChat(CHAT)!.lastDigestAt, T0);
});
