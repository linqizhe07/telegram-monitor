import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Activity } from '../src/activity.ts';
import { alertsAfter, formatNew, inContext, linkPattern, newMessages, phrasesOf, placeOf, search, setPlace, sourcesOf, statusView } from '../src/agent-views.ts';
import type { StoredMessage } from '../src/store.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'Asia/Shanghai', rsiMode: 'auto' as const };
const PUBLIC = -1001111111111;
const PRIVATE = -1002222222222;
const OFF = -1003333333333;

function msg(chatId: number, messageId: number, date: number, text: string, over: Partial<StoredMessage> = {}): StoredMessage {
  return { chatId, messageId, threadId: null, userId: 1, date, text, replyTo: null, reactions: 0, edited: false, ...over };
}

function world() {
  const clock = new Clock(T0 + 86_400);
  const store = memoryStore(clock);
  store.watchChat({ chatId: PUBLIC, title: 'Public Group', username: 'public_group', type: 'supergroup', ref: '@public_group' }, 42, null, defaults);
  store.watchChat({ chatId: OFF, title: 'Switched Off', username: null, type: 'supergroup', ref: String(OFF) }, 42, null, defaults);
  store.watchChat({ chatId: PRIVATE, title: 'Private Group', username: null, type: 'supergroup', ref: String(PRIVATE) }, 42, null, defaults);
  store.updateChat(OFF, { enabled: false });
  store.setKv(`reader_off_reason:${OFF}`, 'claude');
  for (const chatId of [PUBLIC, PRIVATE, OFF]) {
    store.upsertUser(chatId, 1, 'Alice', 'alice');
    store.upsertUser(chatId, 2, 'Bob', null);
  }
  return { clock, store, now: clock.now() };
}

test('sources are numbered in the order they were added: a new one takes the next number, the others keep theirs', () => {
  const { clock, store } = world();
  const before = sourcesOf(store).map((c) => c.chatId);
  clock.t += 60;
  // A newer supergroup has a lower (more negative) id, so by id it would come first.
  store.watchChat({ chatId: -1009999999999, title: 'Joined Later', username: null, type: 'supergroup', ref: '-1009999999999' }, 42, null, defaults);
  assert.deepEqual(sourcesOf(store).map((c) => c.chatId), [...before, -1009999999999]);
});

test("the service's downtime is measured from its own last row: Claude's MCP server writes rows while it is off", () => {
  const { clock, store } = world();
  const activity = new Activity(store);
  activity.event('reader', 'stored', 'Public Group', '1 new message');
  const serviceRow = store.lastActivityId();
  clock.t += 3 * 3600;
  activity.record({ actor: 'claude', kind: 'agent', method: 'whats_new', target: '', detail: 'reader daily' });
  assert.equal(store.lastServiceActivity()?.id, serviceRow);
});

test('message links: public chats by name, private supergroups by id, basic groups none', () => {
  assert.equal(linkPattern({ chatId: PUBLIC, username: 'public_group' }), 'https://t.me/public_group/<id>');
  assert.equal(linkPattern({ chatId: PRIVATE, username: null }), 'https://t.me/c/2222222222/<id>');
  assert.equal(linkPattern({ chatId: -4567, username: null }), null);
});

test('what is new goes by storage order: a catch-up of old messages is new, and each reader keeps its place', () => {
  const { store, now } = world();
  const on = sourcesOf(store).filter((c) => c.enabled);
  assert.deepEqual(on.map((c) => c.chatId), [PUBLIC, PRIVATE].sort((a, b) => a - b), 'the switched-off source is left out');
  store.saveMessage(msg(PUBLIC, 1, now - 3600, 'BTC 突破 10 万了'));
  store.saveMessage(msg(PRIVATE, 7, now - 1800, 'ETH ETF 今天过了吗'));
  store.saveMessage(msg(OFF, 3, now - 60, 'not read: switched off'));

  const first = newMessages(store, { place: null, chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 });
  assert.equal(first.started, 'first');
  assert.equal(first.count, 2);
  assert.equal(first.more, false);
  setPlace(store, 'messages', 'daily', first.to, now);

  const again = newMessages(store, { place: placeOf(store, 'messages', 'daily'), chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 });
  assert.equal(again.started, 'kept');
  assert.equal(again.count, 0, 'nothing new for the same reader');
  const other = newMessages(store, { place: placeOf(store, 'messages', 'chat'), chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 });
  assert.equal(other.count, 2, 'another reader has its own place');

  // A catch-up after an outage stores a message posted 20 hours ago: it is new to the reader.
  store.saveMessage(msg(PUBLIC, 2, now - 20 * 3600, '停机期间的旧消息'));
  const late = newMessages(store, { place: placeOf(store, 'messages', 'daily'), chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 });
  assert.deepEqual(late.groups.map((g) => g.messages.map((m) => m.messageId)), [[2]]);

  // An edit keeps the message's place: it does not come back as new.
  setPlace(store, 'messages', 'daily', late.to, now);
  store.saveMessage(msg(PUBLIC, 1, now - 3600, 'BTC 突破 10 万了（改）', { edited: true }));
  assert.equal(newMessages(store, { place: placeOf(store, 'messages', 'daily'), chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 }).count, 0);

  const text = formatNew(store, first, 'all', 600).join('\n');
  assert.match(text, /## Public Group · 1 new .* message links: https:\/\/t\.me\/public_group\/<id>/);
  assert.match(text, /\[#7 \d\d:\d\d Alice\] ETH ETF/);
});

test('what is new comes in parts that fit, and starts over after storage was cleared', () => {
  const { store, now } = world();
  const on = sourcesOf(store).filter((c) => c.enabled);
  for (let i = 1; i <= 30; i++) store.saveMessage(msg(PUBLIC, i, now - 3000 + i, `message number ${i} `.repeat(10)));

  // A first look shows the newest that fit, says how many it left out, and starts the place at the end.
  const first = newMessages(store, { place: null, chats: on, now, firstHours: 24, budget: 1000, maxMessageChars: 600 });
  assert.ok(first.count > 0 && first.count < 30);
  assert.equal(first.more, false);
  assert.equal(first.skipped, 30 - first.count);
  assert.equal(first.waiting.get(PUBLIC), 30);
  assert.deepEqual(first.groups[0].messages.map((m) => m.messageId), Array.from({ length: first.count }, (_, i) => 31 - first.count + i), 'the newest ones');
  assert.equal(first.to, store.lastMessageRow());

  // From a kept place, the oldest come first and every message comes once.
  let place = { row: first.from, at: now };
  let seen = 0;
  const ids: number[] = [];
  for (let round = 0; round < 40 && seen < 30; round++) {
    const next = newMessages(store, { place, chats: on, now, firstHours: 24, budget: 1000, maxMessageChars: 600 });
    assert.equal(next.started, 'kept');
    assert.equal(next.skipped, 0);
    if (round === 0) assert.equal(next.more, true);
    seen += next.count;
    ids.push(...next.groups.flatMap((g) => g.messages.map((m) => m.messageId)));
    place = { row: next.to, at: now };
  }
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => i + 1), 'every message once, in order, nothing skipped');

  setPlace(store, 'messages', 'daily', store.lastMessageRow(), now);
  store.clearStored({ messages: true });
  store.saveMessage(msg(PUBLIC, 99, now - 10, 'after the clear'));
  const after = newMessages(store, { place: placeOf(store, 'messages', 'daily'), chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 });
  assert.equal(after.started, 'reset');
  assert.deepEqual(after.groups.flatMap((g) => g.messages.map((m) => m.messageId)), [99]);
  // Positions start over after a clear: a place from before is reset even once the new rows pass it.
  for (let i = 100; i < 140; i++) store.saveMessage(msg(PUBLIC, i, now - 5, `new ${i}`));
  assert.equal(newMessages(store, { place: { row: 3, at: now, epoch: 0 }, chats: on, now, firstHours: 24, budget: 10_000, maxMessageChars: 600 }).started, 'reset');
});

test('search goes across the groups: any of several phrases, Latin letters in any case, by author', () => {
  const { store, now } = world();
  const on = sourcesOf(store).filter((c) => c.enabled);
  store.saveMessage(msg(PUBLIC, 1, now - 300, 'zcash is pumping'));
  store.saveMessage(msg(PRIVATE, 2, now - 200, '大零币今天涨了', { userId: 2 }));
  store.saveMessage(msg(PRIVATE, 3, now - 100, 'nothing here'));
  store.saveMessage(msg(OFF, 4, now - 50, 'ZEC in a switched-off group'));
  const phrases = phrasesOf(' ZEC | Zcash |大零币| ');
  assert.deepEqual(phrases, ['ZEC', 'Zcash', '大零币']);
  const found = search(store, { chats: on, phrases, from: now - 3600, to: now + 1, limit: 10 });
  assert.deepEqual(found.map((f) => [f.chat.chatId, f.m.messageId]), [[PRIVATE, 2], [PUBLIC, 1]], 'newest first; the switched-off group is not searched');
  assert.equal(found[1].link, 'https://t.me/public_group/1');
  assert.equal(found[0].link, 'https://t.me/c/2222222222/2');
  assert.deepEqual(search(store, { chats: on, phrases, from: now - 3600, to: now + 1, author: 'bob', limit: 10 }).map((f) => f.m.messageId), [2]);
  assert.deepEqual(search(store, { chats: on, phrases, from: now - 3600, to: now + 1, author: '@alice', limit: 10 }).map((f) => f.m.messageId), [1]);
});

test('a message in context: what it replies to, its replies, and its neighbours', () => {
  const { store, now } = world();
  const chat = store.getChat(PUBLIC)!;
  store.saveMessage(msg(PUBLIC, 10, now - 500, 'root question'));
  store.saveMessage(msg(PUBLIC, 11, now - 400, 'unrelated'));
  store.saveMessage(msg(PUBLIC, 12, now - 300, 'answer', { replyTo: 10 }));
  store.saveMessage(msg(PUBLIC, 13, now - 200, 'follow-up', { replyTo: 12 }));
  store.saveMessage(msg(PUBLIC, 14, now - 100, 'later'));
  const thread = inContext(store, chat, [12, 999], { around: 0, thread: true });
  assert.deepEqual(thread.messages.map((m) => m.messageId), [10, 12, 13]);
  assert.deepEqual(thread.missing, [999]);
  const near = inContext(store, chat, [12], { around: 1, thread: false });
  assert.deepEqual(near.messages.map((m) => m.messageId), [11, 12, 13]);
});

test('alerts: what needs attention, and only that, oldest first or newest first', () => {
  const { store, now } = world();
  const activity = new Activity(store);
  activity.event('reader', 'stored', 'Public Group', '3 new messages');
  activity.event('reader', 'connection lost', 'Telegram', 'retrying', false);
  activity.event('news', 'news in the group', 'Public Group', '5 messages from 4 people about BTC');
  activity.event('notify', 'verifying', 'Private Group', 'macOS notification queued');
  activity.event('claude', 'flagged', 'Private Group', 'A deadline tomorrow · #7 · via Claude Code');
  activity.event('reader', 'was off', 'service', 'not running from 01:00 to 02:00 UTC (60 min)');
  const all = alertsAfter(store, 0, 50);
  assert.deepEqual(all.map((a) => a.kind), ['news-hot', 'owner-action', 'flag', 'service']);
  assert.equal(all[0].chatId, PUBLIC);
  assert.match(all[1].text, /the owner answers it in the Telegram app/);
  assert.equal(all[3].group, null);
  assert.deepEqual(alertsAfter(store, 0, 2, true).map((a) => a.kind), ['service', 'flag']);
  assert.deepEqual(alertsAfter(store, all[1].id, 50).map((a) => a.kind), ['flag', 'service']);
  assert.equal(store.lastAttentionId(), all[3].id);
  assert.ok(now > 0);
});

test('status: every source numbered as the tools take them, what is wrong, and what Claude did', () => {
  const { store, now } = world();
  const activity = new Activity(store);
  store.saveMessage(msg(PUBLIC, 1, now - 300, 'hello'));
  store.updateChat(PRIVATE, { readerError: 'CHANNEL_PRIVATE' });
  activity.record({ actor: 'claude', kind: 'agent', method: 'read_messages', target: 'Public Group', detail: '24h' });
  activity.event('claude', 'digest saved', 'Public Group', '1200 chars');
  const down = statusView(store, { now, running: false, live: null, newsOn: false, autoReadDefault: true });
  // Numbered in list_sources order (by chat id), switched-off ones included: #n means the same everywhere.
  assert.deepEqual(down.sources.map((s) => [s.n, s.title, s.on]), [[1, 'Switched Off', false], [2, 'Private Group', true], [3, 'Public Group', true]]);
  assert.equal(down.sources.find((s) => s.chatId === OFF)!.offReason, 'switched off by Claude');
  assert.equal(down.service.running, false);
  assert.match(down.problems[0], /not running/);
  assert.ok(down.problems.some((p) => p.startsWith('Private Group: CHANNEL_PRIVATE')));
  assert.equal(down.claude.digests24h, 1);
  assert.equal(down.claude.actions24h, 2);
  assert.equal(down.last24h.messagesStored, 1);

  const up = statusView(store, {
    now,
    running: true,
    live: { startedAt: now - 60, account: { connection: { state: 'online', since: now - 60 } }, peekSeconds: 10, sources: [{ chatId: PUBLIC, pushed: false, peeked: true, member: true, everyS: 120, behind: false }, { chatId: PRIVATE, pushed: false, peeked: false, member: false, everyS: 30, behind: false }] },
    newsOn: false,
    autoReadDefault: true,
  });
  assert.equal(up.service.telegram, 'online');
  assert.equal(up.sources.find((s) => s.chatId === PUBLIC)!.reading, 'checked for new messages every 10s (a full read every 120s besides)');
  assert.equal(up.sources.find((s) => s.chatId === PRIVATE)!.reading, 'read every 30s');
  assert.ok(!up.problems.some((p) => /not running/.test(p)));
});
