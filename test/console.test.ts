import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Activity, classify, describeTarget } from '../src/activity.ts';
import { ConsoleServer } from '../src/console/server.ts';
import { RecordingApi } from '../src/recording.ts';
import { Clock, memoryStore, testConfig } from './helpers.ts';

test('requests are sorted into reads, writes and upkeep; anything unknown counts as a write', () => {
  assert.equal(classify('messages.GetHistory'), 'read');
  assert.equal(classify('contacts.ResolveUsername'), 'read');
  assert.equal(classify('channels.GetFullChannel'), 'read');
  assert.equal(classify('messages.CheckChatInvite'), 'read');
  assert.equal(classify('channels.JoinChannel'), 'write');
  assert.equal(classify('messages.ImportChatInvite'), 'write');
  assert.equal(classify('messages.SendMessage'), 'write');
  assert.equal(classify('channels.ReadHistory'), 'write', 'marking read changes the account');
  assert.equal(classify('messages.GetBotCallbackAnswer'), 'write', 'pressing a button is seen by the bot');
  assert.equal(classify('messages.GetMessagesViews', { increment: true }), 'write');
  assert.equal(classify('messages.GetMessagesViews', { increment: false }), 'read');
  assert.equal(classify('help.GetConfig'), 'system');
  assert.equal(classify('updates.GetState'), 'system');
  assert.equal(classify('InvokeWithLayer'), 'system');
  assert.equal(classify('payments.SomethingNew'), 'write');
  assert.equal(classify('payments.GetPaymentForm'), 'write', 'nothing about payments is a plain read here');
  assert.equal(classify('help.GetAppConfig'), 'read', 'paced and recorded, not hidden as upkeep');
  assert.equal(classify('updates.GetChannelDifference'), 'read');
  assert.equal(classify('messages.RequestWebView'), 'write');
  assert.equal(classify('chatlists.JoinChatlistInvite'), 'write');

  const titles = (id: number) => (id === -1001136071376 ? '币安官方中文群' : null);
  assert.equal(describeTarget({ peer: { className: 'InputPeerChannel', channelId: '1136071376' } }, titles), '币安官方中文群');
  assert.equal(describeTarget({ channel: { className: 'InputChannel', channelId: 99 } }, titles), '-1000000000099');
  assert.equal(describeTarget({ username: 'BinanceChinese' }, titles), '@BinanceChinese');
  assert.equal(describeTarget({ hash: 'AbCdEfGh1234' }, titles), 'invite AbCd…');
  assert.equal(describeTarget({ id: [{ className: 'InputUserSelf' }] }, titles), 'self');
});

test('with no bot token, outgoing messages are kept for the console and nothing is sent', async () => {
  const store = memoryStore(new Clock());
  const activity = new Activity(store);
  const api = new RecordingApi(null, store, activity);
  const m = await api.sendMessage(700000001, '<b>Digest</b> &amp; more');
  assert.ok(m.message_id < 0);
  const [kept] = store.outbox();
  assert.equal(kept.html, '<b>Digest</b> &amp; more');
  assert.equal(kept.delivered, false);
  const [row] = store.activity();
  assert.equal(row.method, 'keep in console');
  assert.equal(row.detail, 'Digest & more');
  await assert.rejects(api.getMe(), /no bot token/);
});

function call(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('the console serves the page, guards its host and its actions, and streams activity', async (t) => {
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001 });
  const server = new ConsoleServer({
    store,
    activity,
    config,
    port: 0,
    now: clock.now,
    log: () => undefined,
    startedAt: clock.now(),
    account: null,
    reader: null,
    bot: null,
    claude: { ready: false, model: config.model },
  });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(server.url).port);
  try {
    const page = await call(port, '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    const token = /name="console-token" content="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(token && token !== '__CONSOLE_TOKEN__');
    assert.equal((await call(port, '/console.js')).status, 200);

    assert.equal((await call(port, '/api/state', { host: 'evil.example:80' })).status, 421, 'DNS rebinding is refused');
    const noToken = await call(port, '/api/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"target":"@x"}' });
    assert.equal(noToken.status, 403);
    const form = await call(port, '/api/probe', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-console-token': token! }, body: '{}' });
    assert.equal(form.status, 403, 'a cross-site form post is refused');
    const probed = await call(port, '/api/probe', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token! }, body: '{"target":"@x"}' });
    assert.deepEqual(JSON.parse(probed.body), { error: 'The reader account is not signed in.' });

    activity.record({ actor: 'reader', kind: 'read', method: 'messages.GetHistory', target: 'a group' });
    activity.record({ actor: 'reader', kind: 'write', method: 'channels.JoinChannel', target: 'a group' });
    const state = JSON.parse((await call(port, '/api/state')).body);
    assert.equal(state.activity.counts.read, 1);
    assert.equal(state.activity.counts.write, 1);
    assert.equal(state.activity.lastWrite.method, 'channels.JoinChannel');
    assert.equal(state.account, null);
    assert.equal(state.claude.ready, false);

    // The live stream pushes each new row.
    const streamed = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('event: activity')) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
      req.end();
      setTimeout(() => activity.event('reader', 'stored', 'a group', '3 new messages'), 50);
    });
    assert.match(streamed, /"method":"stored"/);

    // Clearing storage: only with the page's token, and it leaves one line saying it happened.
    const noTokenClear = await call(port, '/api/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"activity":true}' });
    assert.equal(noTokenClear.status, 403);
    const cleared = JSON.parse((await call(port, '/api/clear', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token! }, body: '{"activity":true}' })).body);
    assert.equal(cleared.ok, true);
    assert.match(cleared.message, /^Cleared: deleted \d+ activity rows; storage/);
    const left = store.activity();
    assert.deepEqual(left.map((a) => a.method), ['cleared storage']);
    const storage = JSON.parse((await call(port, '/api/storage')).body);
    assert.equal(storage.activity, 1);
  } finally {
    await server.stop();
  }
});

test('clearing storage deletes what was collected and keeps sources, switches and reading positions', () => {
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
  store.watchChat({ chatId: -100777, title: 'A group', username: 'a_group', type: 'supergroup', ref: '@a_group' }, 42, null, defaults);
  store.updateChat(-100777, { readerCursor: 5150, enabled: false });
  store.setKv('reader_caught_up:-100777', '123');
  store.upsertUser(-100777, 9, 'Somebody', 'somebody');
  for (let i = 1; i <= 3; i++) store.saveMessage({ chatId: -100777, messageId: i, threadId: null, userId: 9, date: clock.now(), text: `m${i}`, replyTo: null, reactions: 0, edited: false });
  activity.event('reader', 'stored', 'A group', '3 new messages');
  store.addOutbox(42, '<b>digest</b>', false);

  const before = store.storageCounts();
  assert.deepEqual(before, { messages: 3, sources: 1, people: 1, activity: 1, digests: 0, outbox: 1, news: 0 });

  const { deleted } = store.clearStored({ messages: true, activity: true, digests: true });
  assert.equal(deleted.messages, 3);
  assert.equal(deleted.people, 1);
  assert.equal(deleted.activity, 1);
  assert.equal(deleted.outbox, 1);
  assert.deepEqual(store.storageCounts(), { messages: 0, sources: 0, people: 0, activity: 0, digests: 0, outbox: 0, news: 0 });

  const kept = store.getChat(-100777)!;
  assert.equal(kept.kind, 'watched');
  assert.equal(kept.enabled, false, 'its switch is kept');
  assert.equal(kept.readerCursor, 5150, 'where it was read up to is kept: nothing is downloaded again');
  assert.equal(store.getKv('reader_caught_up:-100777'), '123');

  // Only what was chosen goes.
  activity.event('reader', 'stored', 'A group', '1 new message');
  store.saveMessage({ chatId: -100777, messageId: 6, threadId: null, userId: 9, date: clock.now(), text: 'kept', replyTo: null, reactions: 0, edited: false });
  store.clearStored({ activity: true });
  assert.equal(store.storageCounts().messages, 1);
  assert.equal(store.storageCounts().activity, 0);
});

test('two tokens: the page can do everything; local tools (Claude) only the actions their tools use', async (t) => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001 });
  const handoffFile = join(mkdtempSync(join(tmpdir(), 'pulse-console-')), 'console.json');
  const server = new ConsoleServer({ store, activity, config, port: 0, now: clock.now, log: () => undefined, startedAt: clock.now(), account: null, reader: null, bot: null, claude: { ready: false, model: config.model }, handoffFile });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(server.url).port);
  try {
    const page = await call(port, '/');
    const pageToken = /name="console-token" content="([^"]+)"/.exec(page.body)![1];
    const toolToken = (JSON.parse(readFileSync(handoffFile, 'utf8')) as { token: string }).token;
    assert.notEqual(pageToken, toolToken);
    assert.ok(!page.body.includes(toolToken), 'the page never carries the tool token');
    const post = (path: string, token: string, body = '{}') => call(port, path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body });
    for (const path of ['/api/invite/confirm', '/api/invite/recheck', '/api/invite/dismiss', '/api/membership/check', '/api/digest', '/api/settings', '/api/clear', '/api/unwatch', '/api/notify-test', '/api/news/feed', '/api/news/toggle', '/api/news/remove', '/api/discover/dismiss', '/api/join', '/api/verify/press', '/api/verify/answer', '/api/verify/photo', '/api/digest/delete', '/api/pad/look', '/api/pad/send', '/api/pad/react', '/api/pad/save', '/api/pad/read', '/api/pad/mute', '/api/pad/leave', '/api/pad/buttons', '/api/pad/press']) {
      assert.equal((await post(path, toolToken)).status, 403, `${path}: not for local tools`);
      assert.notEqual((await post(path, pageToken)).status, 403, `${path}: the page may`);
    }
    for (const path of ['/api/probe', '/api/watch', '/api/pull', '/api/audit', '/api/toggle', '/api/refresh', '/api/flag', '/api/news/refresh', '/api/discover']) {
      assert.notEqual((await post(path, toolToken, '{"target":"@x","chatId":1}')).status, 403, `${path}: what Claude's tools call`);
    }
    const state = JSON.parse((await call(port, '/api/state')).body);
    assert.equal(state.privateGroups, null, 'no reader account: no private-group state');
    assert.equal(JSON.parse((await call(port, '/api/news')).body).enabled, false, 'no radar: the panel stays hidden');
  } finally {
    await server.stop();
  }
});

test('clearing digests removes the files in every group folder, and the empty folders', async (t) => {
  const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = mkdtempSync(join(tmpdir(), 'pulse-digests-'));
  mkdirSync(join(dataDir, 'digests', '币安官方中文群'), { recursive: true });
  writeFileSync(join(dataDir, 'digests', '币安官方中文群', '2026-10-07 0044.md'), '# a');
  writeFileSync(join(dataDir, 'digests', '2026-10-06-Old.md'), '# older layout');
  writeFileSync(join(dataDir, 'digests', 'notes.txt'), 'not a digest');
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001, dbPath: join(dataDir, 'pulse.db') });
  const server = new ConsoleServer({ store, activity, config, port: 0, now: clock.now, log: () => undefined, startedAt: clock.now(), account: null, reader: null, bot: null, claude: { ready: false, model: config.model } });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(server.url).port);
  try {
    const token = /name="console-token" content="([^"]+)"/.exec((await call(port, '/')).body)![1];
    assert.equal(JSON.parse((await call(port, '/api/storage')).body).digestFiles, 2, 'files in group folders are counted');
    const r = JSON.parse((await call(port, '/api/clear', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: '{"digests":true}' })).body);
    assert.match(r.message, /2 digest files/);
    assert.equal(existsSync(join(dataDir, 'digests', '币安官方中文群')), false, 'the empty group folder is gone');
    assert.equal(existsSync(join(dataDir, 'digests', 'notes.txt')), true, 'only digests are deleted');
  } finally {
    await server.stop();
  }
});

test('deleting one digest takes its row and its file, and nothing else', async (t) => {
  const { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { escapeHtml } = await import('../src/render.ts');
  const dataDir = mkdtempSync(join(tmpdir(), 'pulse-delete-'));
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001, dbPath: join(dataDir, 'pulse.db') });
  const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
  store.watchChat({ chatId: -1001, title: 'A <&> B', username: 'ab', type: 'supergroup', ref: '@ab' }, 700000001, null, defaults);
  store.watchChat({ chatId: -1002, title: 'Quiet', username: 'q', type: 'supergroup', ref: '@q' }, 700000001, null, defaults);
  // As save_digest keeps them: a row with the heading in bold, and a file whose first line is "# heading".
  const save = (title: string, chatId: number, head: string, markdown: string, file: string) => {
    const id = store.addOutbox(700000001, `<b>${escapeHtml(head)}</b>\n\n${escapeHtml(markdown)}`, false, chatId);
    mkdirSync(join(dataDir, 'digests', title), { recursive: true });
    writeFileSync(join(dataDir, 'digests', title, file), `# ${head}\n\n${markdown}\n`);
    clock.t += 60;
    return id;
  };
  const one = save('A  B', -1001, 'A <&> B · 10/6 09:00 → 10/7 09:00 (UTC) · written by Claude', '## Topics\n- one <b>not html</b> #12', '2026-10-07 0900.md');
  const two = save('A  B', -1001, 'A <&> B · 10/7 09:00 → 10/8 09:00 (UTC) · written by Claude', '## Topics\n- two', '2026-10-08 0900.md');
  const quiet = save('Quiet', -1002, 'Quiet · 10/7 09:00 → 10/8 09:00 (UTC) · written by Claude', 'nothing much', '2026-10-08 0900.md');
  // The owner edited this file: it is still found by its first line.
  writeFileSync(join(dataDir, 'digests', 'Quiet', '2026-10-08 0900.md'), '# Quiet · 10/7 09:00 → 10/8 09:00 (UTC) · written by Claude\r\n\nmy own notes\r\n');
  // The same digest saved twice: its file stays until the last row with that heading goes.
  const twinA = save('Quiet', -1002, 'Quiet · 10/8 09:00 → 10/9 09:00 (UTC) · written by Claude', 'twice', '2026-10-09 0900.md');
  const twinB = store.addOutbox(700000001, store.outboxRow(twinA)!.html, false, -1002);
  // A digest the service wrote and kept here in two parts: it goes whole, with its record.
  const partA = store.addOutbox(700000001, '<b>Daily digest</b>\n\npart one', false);
  const partB = store.addOutbox(700000001, 'part two', false);
  const record = store.saveDigest({ chatId: -1002, kind: 'production', windowStart: clock.now() - 86_400, windowEnd: clock.now(), genomeVersion: 0, digest: {} as never, metrics: null });
  store.setPosted(record, [-partA, -partB]);
  const sent = store.addOutbox(700000001, 'pong', true);

  const server = new ConsoleServer({ store, activity, config, port: 0, now: clock.now, log: () => undefined, startedAt: clock.now(), account: null, reader: null, bot: null, claude: { ready: false, model: config.model } });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(server.url).port);
  try {
    const token = /name="console-token" content="([^"]+)"/.exec((await call(port, '/')).body)![1];
    const del = async (id: number) => JSON.parse((await call(port, '/api/digest/delete', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: JSON.stringify({ id }) })).body);
    const left = () => store.outbox(100).map((r) => r.id).sort((a, b) => a - b);
    const files = (title: string) => (existsSync(join(dataDir, 'digests', title)) ? readdirSync(join(dataDir, 'digests', title)).sort() : null);

    let r = await del(one);
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Deleted the digest «A <&> B · 10/6 09:00 → 10/7 09:00 (UTC) · written by Claude», with its file in data/digests.');
    assert.deepEqual(files('A  B'), ['2026-10-08 0900.md'], "only that digest's file");
    assert.ok(!left().includes(one) && left().includes(two));
    assert.equal((await del(one)).message, 'Already deleted.');

    await del(two);
    assert.equal(files('A  B'), null, 'the empty group folder goes too');

    r = await del(quiet);
    assert.match(r.message, /with its file/, 'an edited file is found by its heading line');
    assert.deepEqual(files('Quiet'), ['2026-10-09 0900.md']);

    r = await del(twinA);
    assert.doesNotMatch(r.message, /file/, 'the twin still has that file');
    assert.deepEqual(files('Quiet'), ['2026-10-09 0900.md']);
    r = await del(twinB);
    assert.match(r.message, /with its file/);
    assert.equal(files('Quiet'), null);

    r = await del(partB);
    assert.match(r.message, /with 2 parts/);
    assert.ok(!left().includes(partA), 'the whole digest goes');
    assert.equal(store.digest(record), null, 'and its record');

    r = await del(sent);
    assert.equal(r.message, 'Deleted the message «pong». The copy in Telegram stays.');
    assert.deepEqual(left(), []);
    assert.deepEqual(store.activity().filter((a) => a.method.endsWith(' deleted')).map((a) => [a.actor, a.method, a.target]).slice(-2), [['console', 'digest deleted', 'Quiet'], ['console', 'message deleted', 'Other messages']]);
    assert.equal((await del(0)).ok, false);
  } finally {
    await server.stop();
  }
});

test('the pulse: each group\'s messages per hour, what the denoiser removed, and how long new messages took to be stored', async (t) => {
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001 });
  const GROUP = -1001111111111;
  store.watchChat({ chatId: GROUP, title: 'A group', username: 'a_group', type: 'supergroup', ref: '@a_group' }, 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  const now = clock.now();
  const dates = [now - 30 * 3600, now - 2 * 3600 - 10, now - 30, now - 8];
  const texts = ['an old one', '大饼要涨到10万了', 'hi', '/start'];
  dates.forEach((date, i) => store.saveMessage({ chatId: GROUP, messageId: i + 1, threadId: null, userId: 5, date, text: texts[i], replyTo: null, reactions: 0, edited: false }));
  // Two chats with one title (a channel and its discussion group): their events say nothing about which.
  const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
  store.watchChat({ chatId: -1003333333333, title: 'Twin', username: 'twin_a', type: 'channel', ref: '@twin_a' }, 42, null, defaults);
  store.watchChat({ chatId: -1004444444444, title: 'Twin', username: 'twin_b', type: 'supergroup', ref: '@twin_b' }, 42, null, defaults);
  store.saveMessage({ chatId: -1004444444444, messageId: 9, threadId: null, userId: 6, date: now - 5000, text: 'a quiet one', replyTo: null, reactions: 0, edited: false });
  activity.event('reader', 'stored', 'A group', '2 new messages · noticed by the chat-list check');
  activity.event('reader', 'stored', 'Not a source', '1 new message');
  activity.event('reader', 'stored', 'Twin', '1 new message');
  const server = new ConsoleServer({
    store,
    activity,
    config,
    port: 0,
    now: clock.now,
    log: () => undefined,
    startedAt: now,
    account: null,
    reader: null,
    bot: null,
    claude: { ready: false, model: config.model },
  });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  try {
    const pulse = JSON.parse((await call(Number(new URL(server.url).port), '/api/pulse')).body);
    const row = pulse.hours.find((h: { chatId: number }) => h.chatId === GROUP);
    const first = Math.floor(now / 3600) - 23;
    const expected = Array.from({ length: 24 }, (_, i) => dates.filter((d) => Math.floor(d / 3600) === first + i).length);
    assert.deepEqual(row.counts, expected, 'the message 30 hours old is outside the day');
    assert.equal(row.counts.reduce((a: number, b: number) => a + b, 0), 3);
    assert.deepEqual(pulse.lags, [{ at: now, chatId: GROUP, lag: 8 }], 'stored 8 seconds after it was posted; an unknown chat, and a title two chats share, are left out');
    assert.deepEqual(pulse.noise.find((x: { chatId: number }) => x.chatId === GROUP), { chatId: GROUP, total: 3, removed: { sticker: 0, chatter: 1, command: 1, spam: 0, repeat: 0 } });
    // The denoiser's verdict on each of the latest messages, for the crawler's second hand.
    const latest = JSON.parse((await call(Number(new URL(server.url).port), `/api/messages?chat=${GROUP}&limit=3&noise=1`)).body);
    assert.deepEqual(latest.map((m: { text: string; noise: string | null }) => [m.text, m.noise]), [['大饼要涨到10万了', null], ['hi', 'chatter'], ['/start', 'command']]);
    const plain = JSON.parse((await call(Number(new URL(server.url).port), `/api/messages?chat=${GROUP}&limit=10`)).body);
    assert.equal(plain.length, 4, 'without the last day filling the limit, the whole history is read');
    assert.equal('noise' in plain[0], false);
    const all = JSON.parse((await call(Number(new URL(server.url).port), `/api/messages?chat=${GROUP}&limit=10&noise=1`)).body);
    assert.equal('noise' in all[0], false, 'a message older than the judged window carries no verdict (not "kept")');
    assert.equal(all[1].noise, null);
    // The denoiser counts are refreshed in the background, at most once a minute.
    store.saveMessage({ chatId: GROUP, messageId: 5, threadId: null, userId: 7, date: now + 30, text: 'ok', replyTo: null, reactions: 0, edited: false });
    const port = Number(new URL(server.url).port);
    clock.t = now + 30;
    const soon = JSON.parse((await call(port, '/api/pulse')).body);
    assert.equal(soon.noise.find((x: { chatId: number }) => x.chatId === GROUP).total, 3, 'within the minute: the counts already worked out');
    clock.t = now + 61;
    const stale = JSON.parse((await call(port, '/api/pulse')).body);
    assert.equal(stale.noise.find((x: { chatId: number }) => x.chatId === GROUP).total, 3, 'a request never waits for the recount');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = JSON.parse((await call(port, '/api/pulse')).body);
    assert.deepEqual(fresh.noise.find((x: { chatId: number }) => x.chatId === GROUP).removed, { sticker: 0, chatter: 2, command: 1, spam: 0, repeat: 0 }, 'the recount has the new chatter');
  } finally {
    await server.stop();
  }
});

test('Discord channels in the console: their state, and every action that would ask Telegram goes to the Discord bot instead, or is refused', async (t) => {
  const clock = new Clock();
  const store = memoryStore(clock);
  const activity = new Activity(store);
  const config = testConfig({ reportTo: 700000001 });
  const { chat } = store.addDiscordChannel({ channelId: '1100000000000000011', guildId: '1000000000000000001', guildName: 'Ours', name: 'feeds', type: 5 }, 700000001, false, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  const asked: string[] = [];
  const discord = {
    status: () => ({ configured: true, state: 'online', error: null, bot: { id: '2', name: 'pulse-bot' }, invite: 'https://discord.com/oauth2/authorize?client_id=2&scope=bot&permissions=66560', servers: [{ id: '1', name: 'Ours', channels: 1, on: 0 }] }),
    online: () => true,
    catchUp: async () => (asked.push('catchUp'), true),
    catchUpSoon: () => void asked.push('catchUpSoon'),
  };
  const telegramOnly = new Proxy({}, { get: () => () => Promise.reject(new Error('Telegram was asked about a Discord channel')) });
  const server = new ConsoleServer({
    store,
    activity,
    config,
    port: 0,
    now: clock.now,
    log: () => undefined,
    startedAt: clock.now(),
    account: null,
    reader: telegramOnly as never,
    discord: discord as never,
    pad: telegramOnly as never,
    bot: null,
    claude: { ready: false, model: config.model },
  });
  try {
    await server.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(server.url).port);
  try {
    const page = await call(port, '/');
    const token = /name="console-token" content="([^"]+)"/.exec(page.body)![1];
    const post = async (path: string, body: unknown) => JSON.parse((await call(port, path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': token }, body: JSON.stringify(body) })).body);
    assert.equal((await call(port, '/starmap.js')).status, 200);

    const state = JSON.parse((await call(port, '/api/state')).body);
    assert.equal(state.discord.state, 'online');
    const src = state.sources.find((x: { chatId: number }) => x.chatId === chat.chatId);
    assert.equal(src.platform, 'discord');
    assert.equal(src.access, 'discord');
    assert.equal(src.pushed, true, 'pushed by Discord while the bot is connected');
    assert.deepEqual(src.discord, { server: 'Ours', channel: 'feeds', feed: true, announcement: true, link: 'https://discord.com/channels/1000000000000000001/1100000000000000011' });

    assert.equal((await post('/api/toggle', { chatId: chat.chatId, on: true })).ok, true);
    assert.equal((await post('/api/pull', { chatId: chat.chatId })).ok, true);
    assert.deepEqual(asked, ['catchUpSoon', 'catchUp'], 'switched on and caught up by the Discord bot');
    assert.match((await post('/api/audit', { chatId: chat.chatId, hours: 1 })).message, /against Telegram/);
    assert.match((await post('/api/pad/look', { chatId: chat.chatId })).message, /read here, never written/);
    assert.match((await post('/api/pad/send', { chatId: chat.chatId, text: 'hi' })).message, /read here, never written/);
    assert.match((await post('/api/watch', { target: 'https://discord.com/channels/1/2' })).message, /Discord bot is in its server/);
  } finally {
    await server.stop();
  }
});
