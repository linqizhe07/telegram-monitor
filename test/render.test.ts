import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanize, renderDigest, toPlain, voteKeyboard } from '../src/render.ts';
import { emptyDigest, type Digest } from '../src/schema.ts';
import { messageLink } from '../src/telegram.ts';
import { T0 } from './helpers.ts';

const names = new Map([
  ['U1', '老王'],
  ['U2', 'Kevin <MM>'],
]);
const base = {
  chat: { chatId: -1001234567890, title: 'Alpha & Co', username: null },
  names,
  window: { start: T0, end: T0 + 86_400 },
  timezone: 'Asia/Shanghai',
  lang: 'zh' as const,
  stats: { messages: 120, people: 9 },
  version: 3,
  validIds: new Set([10, 11, 12]),
  streaks: new Map<string, number>(),
};
const item = (title: string, refs: number[] = [10]) => ({ title, detail: `U1 和 U2 说 ${title}`, people: ['U1'], refs, evidence: ['原话'], continues: '' });

test('message links: private supergroup, public group, basic group', () => {
  assert.equal(messageLink({ chatId: -1001234567890, username: null }, 7), 'https://t.me/c/1234567890/7');
  assert.equal(messageLink({ chatId: -100555, username: 'alpha' }, 7), 'https://t.me/alpha/7');
  assert.equal(messageLink({ chatId: -4242, username: null }, 7), null);
});

test('aliases become names as plain text, never @mentions', () => {
  assert.equal(humanize('U1 回复了 U2，U12 没说话，ABCU1 不变', names), '老王回复了 Kevin <MM>，U12 没说话，ABCU1 不变');
  assert.equal(humanize('凌晨 U1 写出原型，U2 和 U1 都同意', names), '凌晨老王写出原型，Kevin <MM> 和老王都同意');
  assert.equal(humanize('U1 and U2 agreed', names), '老王 and Kevin <MM> agreed');
});

test('a digest renders as escaped Telegram HTML with links, severity, streaks and footer', () => {
  const d: Digest = {
    ...emptyDigest(),
    quiet: false,
    headline: '今天主要在聊 <API key>',
    topics: [item('权限太粗')],
    pain_points: [{ ...item('提币卡住'), severity: 'high' }],
    opportunities: [{ ...item('亚洲时段做市', [11]), why_now: '美股休市', next_step: '找做市商聊' }],
    open_questions: [item('没人回答', [999])],
  };
  const [html, ...rest] = renderDigest(d, { ...base, streaks: new Map([['pain_points:0', 3]]) });
  assert.equal(rest.length, 0);
  assert.ok(html.startsWith('<b>📡 Alpha &amp; Co</b>'));
  assert.ok(html.includes('今天主要在聊 &lt;API key&gt;'));
  assert.ok(html.includes('老王和 Kevin &lt;MM&gt; 说 权限太粗 <a href="https://t.me/c/1234567890/10">↗</a>'));
  assert.ok(html.includes('<b>提币卡住</b> ‼️'));
  assert.ok(html.includes('<i>↻ 第3天</i>'));
  assert.ok(html.includes('<i>“原话”</i>'));
  assert.ok(html.includes('↳ <i>为什么是现在</i>: 美股休市 · <i>下一步</i>: 找做市商聊'));
  assert.ok(!html.includes('/999'), 'a citation to a message outside the window gets no link');
  assert.ok(html.includes('🧬 playbook v3'));
  assert.ok(!html.includes('@'));
  assert.ok(!html.includes('💡'), 'empty sections are left out');
});

test('long digests split between items, never inside one', () => {
  const many = Array.from({ length: 60 }, (_, i) => item(`话题 ${i} ${'很长的说明'.repeat(12)}`));
  const parts = renderDigest({ ...emptyDigest(), quiet: false, headline: 'h', topics: many }, base);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 3900, `part of ${p.length} chars`);
  const text = parts.map(toPlain).join('\n');
  for (let i = 0; i < 60; i++) assert.ok(text.includes(`${i + 1}. 话题 ${i} `));
  assert.ok(parts.at(-1)!.includes('playbook v3'));
});

test('quiet day', () => {
  const [html] = renderDigest({ ...emptyDigest(), headline: '' }, { ...base, lang: 'en' });
  assert.ok(html.includes('A quiet day'));
});

test('vote buttons carry the digest id and counts', () => {
  const kb = voteKeyboard('en', 17, { up: 2, down: 0 });
  assert.deepEqual(kb, [
    [
      { text: '👍 Useful · 2', callback_data: 'v:17:1' },
      { text: '👎 Not useful', callback_data: 'v:17:-1' },
    ],
  ]);
});
