import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestFileHeading, digestFolders, splitHeading } from '../src/digest-folders.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };

test('digests are filed by group: as recorded, through the digest they were posted for, or by the title in their heading', () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  store.watchChat({ chatId: -1001, title: 'Binance', username: 'b', type: 'supergroup', ref: '@b' }, 42, null, DEFAULTS);
  store.watchChat({ chatId: -1002, title: 'Binance English', username: 'be', type: 'supergroup', ref: '@be' }, 42, null, DEFAULTS);
  store.watchChat({ chatId: -1003, title: 'A & B', username: 'ab', type: 'supergroup', ref: '@ab' }, 42, null, DEFAULTS);

  const saved = store.addOutbox(42, '<b>Binance · 10/6 → 10/7 · written by Claude</b>\n\nbody one', false, -1001);
  clock.t += 60;
  const old = store.addOutbox(42, '<b>Binance English · 10/6 → 10/7 · written by Claude</b>\n\nolder row, no group recorded', false);
  clock.t += 60;
  const posted = store.addOutbox(42, '<b>Daily digest</b>\n\nposted by the service', false);
  const d = store.saveDigest({ chatId: -1003, kind: 'production', windowStart: T0, windowEnd: T0 + 1, genomeVersion: 0, digest: {} as never, metrics: null });
  store.setPosted(d, [-posted]);
  clock.t += 60;
  store.addOutbox(42, 'pong', true);

  const folders = digestFolders(store.outbox(50), store.recentDigests(50), store.listChats(false));
  const by = Object.fromEntries(folders.map((f) => [f.title, f.items.map((i) => i.id)]));
  assert.deepEqual(by['Binance'], [saved]);
  assert.deepEqual(by['Binance English'], [old], 'the longer title wins over "Binance"');
  assert.deepEqual(by['A & B'], [posted]);
  assert.equal(folders[folders.length - 1].title, 'Other messages', 'other messages last');
  assert.equal(folders[folders.length - 1].items[0].heading, 'pong');
  assert.equal(folders.find((f) => f.title === 'Binance')!.items[0].format, 'markdown', "Claude's digests are Markdown");
  assert.equal(folders[folders.length - 1].items[0].format, 'html');
  assert.deepEqual(folders.slice(0, 3).map((f) => f.title), ['A & B', 'Binance English', 'Binance'], 'newest group first');
});

test('a digest heading is split off its body', () => {
  assert.deepEqual(splitHeading('<b>X · 1 → 2 &amp; more</b>\n\n## Topics'), { heading: 'X · 1 → 2 & more', body: '## Topics' });
  assert.deepEqual(splitHeading('just a reply'), { heading: 'just a reply', body: 'just a reply' });
});

test("a digest Claude saved names its file's first line; anything else has no file", () => {
  assert.equal(digestFileHeading('<b>A &lt;&amp;&gt; B · 10/6 → 10/7 (UTC) · written by Claude</b>\n\n## Topics'), '# A <&> B · 10/6 → 10/7 (UTC) · written by Claude');
  assert.equal(digestFileHeading('<b>Daily digest</b>\n\nposted by the service'), null);
  assert.equal(digestFileHeading('pong'), null);
  assert.equal(digestFileHeading('<b>X · written by Claude</b> and more on the line\n'), null);
});
