import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Activity } from '../src/activity.ts';
import { alertsAfter } from '../src/agent-views.ts';
import type { StoredMessage } from '../src/store.ts';
import { TermWatch } from '../src/term-watch.ts';
import { ALERT_BURST, bursts, termsOf } from '../src/terms.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const CHAT = -1001111111111;
let next = 1;
const msg = (date: number, userId: number, text: string): StoredMessage => ({ chatId: CHAT, messageId: next++, threadId: null, userId, date, text, replyTo: null, reactions: 0, edited: false });

/** A day of ordinary chat (different people, different words), then whatever the test adds. */
function ordinaryDay(now: number): StoredMessage[] {
  const out: StoredMessage[] = [];
  const lines = ['大饼今天走势一般', '以太坊的手续费又涨了', '合约爆仓的人不少', '新币上线了没有', 'BNB 链上的项目怎么样', '空投什么时候发', '这个月行情很难做'];
  for (let i = 0; i < 400; i++) out.push(msg(now - 86_400 - 1800 + i * 210, 100 + (i % 40), lines[i % lines.length]));
  return out;
}

test('terms of a message: Latin words and tickers in lower case, Chinese phrases of 2–4 characters, no filler', () => {
  const t = termsOf('$ZEC pumping, gm 早上好！提现不了怎么办 https://t.me/x/1');
  assert.ok(t.has('zec') && t.has('pumping'));
  assert.ok(!t.has('gm') && !t.has('早上好'), 'greetings are filler');
  assert.ok(t.has('提现') && t.has('提现不了'));
  assert.ok(!t.has('怎么'), 'common words are left out');
  assert.ok(![...t].some((x) => x.includes('t.me')), 'links are not terms');
  assert.ok(!termsOf('我的钱包').has('我的'), 'fragments ending on a particle are left out');
});

test('a burst: many people suddenly saying the same thing; not one person, not what is said all day', () => {
  const now = T0 + 2 * 86_400;
  const day = ordinaryDay(now);
  // Six people in the last half hour: "提现不了". One spammer: "暴富群" eight times.
  for (let i = 0; i < 8; i++) day.push(msg(now - 1500 + i * 150, 1 + (i % 6), `币安提现不了，卡了${i}分钟`));
  for (let i = 0; i < 8; i++) day.push(msg(now - 1400 + i * 120, 99, `进暴富群 ${i}`));
  // Said all day long, and in the window too: not a burst.
  for (let i = 0; i < 8; i++) day.push(msg(now - 1300 + i * 100, 50 + i, '大饼今天走势一般'));
  const found = bursts(day, now, ALERT_BURST);
  assert.deepEqual(found.map((b) => b.term), ['币安提现不了，卡了'], 'the pieces joined back into what was said, once');
  assert.ok(found[0].parts.includes('提现不了') && found[0].parts.includes('卡了'));
  assert.equal(found[0].people, 6);
  assert.equal(found[0].count, 8);
  assert.ok(found[0].ratio > 6);
  assert.equal(found[0].ids.length, 5);
});

test('the same hour on earlier days counts: what is said every morning is not a burst', () => {
  const now = T0 + 3 * 86_400;
  const all: StoredMessage[] = [];
  for (let i = 0; i < 8; i++) all.push(msg(now - 1500 + i * 150, 1 + i, '冲冲冲 开盘了'));
  const yesterday = Array.from({ length: 8 }, (_, i) => msg(now - 86_400 - 1500 + i * 150, 1 + i, '冲冲冲 开盘了'));
  assert.equal(bursts(all, now, ALERT_BURST).length > 0, true, 'without history it stands out');
  assert.equal(bursts(all, now, { ...ALERT_BURST, sameHour: [yesterday] }).length, 0, 'with yesterday at this hour, it is usual');
});

test('the service raises each burst once, as an alert, and again only after a quiet spell', () => {
  const clock = new Clock(T0 + 2 * 86_400);
  const store = memoryStore(clock);
  store.watchChat({ chatId: CHAT, title: 'A Group', username: 'a_group', type: 'supergroup', ref: '@a_group' }, 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  const now = clock.now();
  for (const m of ordinaryDay(now)) store.saveMessage(m);
  for (let i = 0; i < 9; i++) store.saveMessage(msg(now - 1500 + i * 150, 1 + (i % 7), `ZEC 要起飞 ${i}`));
  const activity = new Activity(store);
  const watch = new TermWatch({ store, activity, now: clock.now, quietS: 3600 });
  assert.deepEqual(watch.check(), [{ chatId: CHAT, term: 'ZEC 要起飞', key: 'zec' }]);
  assert.deepEqual(watch.check(), [], 'raised once');
  const [alert] = alertsAfter(store, 0, 10);
  assert.equal(alert.kind, 'term-burst');
  assert.equal(alert.group, 'A Group');
  assert.match(alert.text, /^"ZEC 要起飞": 9 messages from 7 people in the last 30 min \(almost never\) · #\d+/);
  clock.t += 3601;
  for (let i = 0; i < 9; i++) store.saveMessage(msg(clock.now() - 1500 + i * 150, 1 + (i % 7), `ZEC 继续涨 ${i}`));
  assert.deepEqual(watch.check().map((x) => x.key), ['zec'], 'after the quiet spell it can be raised again');
});
