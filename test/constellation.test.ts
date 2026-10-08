import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayMap, galaxiesOf, lastDays, topicsOf, type MapEdge } from '../src/constellation.ts';
import type { StoredMessage } from '../src/store.ts';
import { T0 } from './helpers.ts';

let nextId = 1;
const say = (chatId: number, userId: number, text: string, at = T0): StoredMessage => ({ chatId, messageId: nextId++, threadId: null, userId, date: at + nextId, text, replyTo: null, reactions: 0, edited: false });

test("a group's topics: what at least two people said, without fillers, placeholders or pieces of longer words", () => {
  const msgs = [
    say(1, 11, '币安合约今天爆仓的人好多，比特币跌到六万了'),
    say(1, 12, '比特币又跌了，合约千万别加杠杆 [sticker 😀]'),
    say(1, 13, '不知道为什么比特币跌这么多，合约要小心'),
    say(1, 14, '我买的现货还在，不知道要不要卖'),
    say(1, 15, '我买了一点点现货，不知道对不对'),
  ];
  const t = topicsOf(msgs, false);
  assert.ok(t.has('比特币') && t.get('比特币')! >= 3, 'the whole word, said by three people');
  assert.ok(!t.has('比特') && !t.has('特币'), 'its pieces are gone');
  assert.ok(t.has('合约'));
  assert.ok(!t.has('不知道'), 'a filler');
  assert.ok(!t.has('我买'), 'a piece of a sentence');
  assert.ok(![...t.keys()].some((k) => k.includes('sticker')), 'a placeholder is not talk');
  assert.ok(!t.has('杠杆'), 'said by one person only');

  // A channel speaks alone: its terms count by posts.
  const ch = topicsOf([say(2, 99, 'Trump says Iran talks resume next week, Bessent on tariffs'), say(2, 99, 'Bessent: Trump signals new Iran deal')], true);
  assert.ok(ch.has('trump') && ch.has('iran') && ch.has('bessent'), 'each post counts: they were in two posts');
});

test('the day map: a route only where topics overlap, naming them; groups that overlap form a galaxy', () => {
  const A = -1001;
  const B = -1002;
  const C = -1003;
  const D = -1004;
  const crypto = (chat: number, base: number) => [
    say(chat, base + 1, '币安合约今天又爆仓了，ETH 跌破两千'),
    say(chat, base + 2, 'ETH 合约爆仓太多了，币安客服也不回'),
    say(chat, base + 3, '币安提现慢，ETH 还在跌，合约别碰'),
    say(chat, base + 4, '昨天币安合约爆仓，ETH 现在怎么样'),
  ];
  const input = [
    { chatId: A, channel: false, messages: crypto(A, 100) },
    { chatId: B, channel: false, messages: crypto(B, 200) },
    { chatId: C, channel: false, messages: [say(C, 301, '黄金今天又涨了，美股期权要不要买'), say(C, 302, '美股期权亏了，黄金还在涨'), say(C, 303, '黄金和美股期权都在涨')] },
    { chatId: D, channel: true, messages: [] },
  ];
  const m = dayMap(input, '2026-10-07', T0, T0 + 86_400);
  const ab = m.edges.find((e) => e.a === Math.min(A, B) && e.b === Math.max(A, B));
  assert.ok(ab, 'the two crypto groups are joined');
  assert.ok(ab!.overlap > 0.5);
  for (const t of ['合约', '币安', 'eth']) assert.ok(ab!.topics.includes(t), `${t} is named on the route`);
  assert.ok(!m.edges.some((e) => e.a === C || e.b === C), 'nothing in common with the gold and stocks group: no route');
  assert.deepEqual(m.galaxies.map((g) => g.members), [[Math.min(A, B), Math.max(A, B)]]);
  assert.ok(m.galaxies[0].topics.includes('合约'));
  assert.equal(m.nodes.find((x) => x.chatId === D)!.messages, 0, 'a quiet day: no topics, no routes');
  assert.ok(m.nodes.find((x) => x.chatId === C)!.topics.includes('黄金'));
});

test('galaxies merge while their groups overlap enough on average', () => {
  const e = (a: number, b: number, overlap: number): MapEdge => ({ a, b, overlap, topics: [] });
  assert.deepEqual(galaxiesOf([1, 2, 3, 4], [e(1, 2, 0.3), e(2, 3, 0.08), e(1, 3, 0.06)]), [[1, 2, 3]]);
  assert.deepEqual(galaxiesOf([1, 2, 3, 4], [e(1, 2, 0.3), e(2, 3, 0.04)]), [[1, 2]], 'too weak a link to the third');
  assert.deepEqual(galaxiesOf([1, 2], []), []);
});

test('days run from local midnight, today first', () => {
  // 2026-10-08 03:00 in Shanghai is 2026-10-07 19:00 UTC.
  const now = Date.UTC(2026, 9, 7, 19, 0) / 1000;
  const days = lastDays(now, 'Asia/Shanghai', 3);
  assert.deepEqual(days.map((d) => d.day), ['2026-10-08', '2026-10-07', '2026-10-06']);
  assert.equal(days[0].from, Date.UTC(2026, 9, 7, 16, 0) / 1000, 'midnight in Shanghai');
  assert.equal(days[0].to, now);
  assert.equal(days[1].to, days[0].from);
  assert.equal(days[1].to - days[1].from, 86_400);
});
