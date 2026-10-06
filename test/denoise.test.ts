import assert from 'node:assert/strict';
import { test } from 'node:test';
import { core, denoise, formatSignal, noiseKind, onTopic } from '../src/denoise.ts';
import type { StoredMessage } from '../src/store.ts';

const CHAT = -1001136071376;
let nextId = 1;
const at = (sec: number) => 1_790_000_000 + sec;
function m(userId: number, sec: number, text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { chatId: CHAT, messageId: nextId++, threadId: null, userId, date: at(sec), text, replyTo: null, reactions: 0, edited: false, ...extra };
}

test('noise: stickers, fillers, bot commands and scams; engagement always keeps a message', () => {
  const plain = (text: string) => noiseKind(m(1, 0, text), 0);
  assert.equal(plain('[sticker 😂]'), 'sticker');
  assert.equal(plain('😂😂😂'), 'sticker');
  assert.equal(plain('哈哈哈哈'), 'chatter');
  assert.equal(plain('早上好'), 'chatter');
  assert.equal(plain('GM!!'), 'chatter');
  assert.equal(plain('666'), 'chatter');
  assert.equal(plain('涨了'), 'chatter', 'two characters say too little alone');
  assert.equal(plain('/rank@BinanceCNLucky_Bot'), 'command');
  assert.equal(plain('私聊我带单，稳赚收益翻倍'), 'spam');
  assert.equal(plain('进群领取 https://t.me/+AbCdEf123'), 'spam');
  assert.equal(plain('DM me to recover your wallet funds'), 'spam');
  assert.equal(plain('提现卡住了怎么办'), null);
  assert.equal(plain('[photo]'), null, 'a photo may be a screenshot of the problem');
  assert.equal(noiseKind(m(1, 0, '？'), 3), null, 'people replied to it');
  assert.equal(noiseKind(m(1, 0, '哈哈', { reactions: 5 }), 0), null, 'people reacted to it');
  assert.equal(core('[forwarded] 🚀 BTC, 62k!'), 'btc62k');
});

test("one person's fragments become one line; another person in between splits them", () => {
  nextId = 100;
  const d = denoise([
    m(1, 0, '还卡提现'),
    m(1, 20, '真的无语了'),
    m(1, 40, '什么进阶kyc真的是'),
    m(2, 50, '直接平台进线客服'),
    m(1, 60, '试过了没用'),
    m(1, 400, '算了明天再说'), // more than 90s later: a new line
  ]);
  assert.deepEqual(
    d.lines.map((l) => [l.ids, l.text]),
    [
      [[100, 101, 102], '还卡提现 / 真的无语了 / 什么进阶kyc真的是'],
      [[103], '直接平台进线客服'],
      [[104], '试过了没用'],
      [[105], '算了明天再说'],
    ],
  );
});

test('a copy-paste wave is folded into its first copy with how many times and people', () => {
  nextId = 200;
  const d = denoise([m(1, 0, '提现不了！'), m(2, 300, '提现不了'), m(3, 600, '提现不了!!'), m(2, 900, '提现 不了')]);
  assert.equal(d.lines.length, 1);
  assert.deepEqual(d.lines[0].echoes, { times: 4, people: 3 });
  assert.equal(d.removed.repeat, 3);
  assert.deepEqual([...d.noise], [[201, 'repeat'], [202, 'repeat'], [203, 'repeat']], 'each removed message, with why');
  assert.ok(d.lines[0].score > 3, 'a wave is a signal of how many people have the problem');
});

test('replies make conversations; off-topic ones are folded, with exact counts in the header', () => {
  nextId = 300;
  const q = m(1, 0, '大陆KYC用户在币安不能用菲律宾比索买usdt吗？');
  const msgs = [
    q,
    m(2, 30, '在国外？', { replyTo: q.messageId }),
    m(3, 60, '大陆KYC只能交易CNY', { replyTo: q.messageId }),
    m(4, 4000, '公立高中跟私立差别很大吗'),
    m(5, 4030, '学习环境不一样', { replyTo: 303 }),
    m(6, 5000, '[sticker 🌟]'),
    m(7, 5100, '哈哈哈'),
  ];
  const d = denoise(msgs);
  assert.equal(d.conversations.length, 2);
  const [kyc, school] = d.conversations;
  assert.equal(kyc.onTopic, true);
  assert.equal(kyc.lines.length, 3);
  assert.equal(kyc.people, 3);
  assert.equal(school.onTopic, false);
  assert.equal(onTopic('币安电汇手续费有点贵'), true);
  assert.equal(onTopic('今天当了第二次大冤种'), false);

  const sig = formatSignal(d, (id) => `P${id}`, () => '08:00');
  assert.match(sig.header, /^7 messages → 2 removed as noise \(1 stickers\/emoji, 1 one-word chatter, 0 bot commands, 0 repeats/);
  assert.match(sig.header, /3 on-topic lines in 1 conversations \(below\), 2 off-topic lines in 1 conversations \(folded\)/);
  assert.equal(sig.blocks.length, 1);
  assert.match(sig.blocks[0], /^── 3 lines · 3 people\n\[#300 08:00 P1\] 大陆KYC/);
  assert.match(sig.blocks[0], /\n {2}\[#301 08:00 P2 ↩300\] 在国外？/);
  assert.match(sig.folded, /#303 \(2 lines, 2 people\) "公立高中跟私立差别很大吗"/);
  const off = formatSignal(d, (id) => `P${id}`, () => '08:00', 'off-topic');
  assert.match(off.blocks[0], /公立高中/);
});
