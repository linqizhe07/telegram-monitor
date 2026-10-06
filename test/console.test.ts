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
  assert.deepEqual(before, { messages: 3, sources: 1, people: 1, activity: 1, digests: 0, outbox: 1 });

  const { deleted } = store.clearStored({ messages: true, activity: true, digests: true });
  assert.equal(deleted.messages, 3);
  assert.equal(deleted.people, 1);
  assert.equal(deleted.activity, 1);
  assert.equal(deleted.outbox, 1);
  assert.deepEqual(store.storageCounts(), { messages: 0, sources: 0, people: 0, activity: 0, digests: 0, outbox: 0 });

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
    for (const path of ['/api/invite/confirm', '/api/invite/recheck', '/api/invite/dismiss', '/api/membership/check', '/api/digest', '/api/settings', '/api/clear', '/api/unwatch', '/api/notify-test']) {
      assert.equal((await post(path, toolToken)).status, 403, `${path}: not for local tools`);
      assert.notEqual((await post(path, pageToken)).status, 403, `${path}: the page may`);
    }
    for (const path of ['/api/probe', '/api/watch', '/api/pull', '/api/audit', '/api/toggle', '/api/refresh']) {
      assert.notEqual((await post(path, toolToken, '{"target":"@x","chatId":1}')).status, 403, `${path}: what Claude's tools call`);
    }
    const state = JSON.parse((await call(port, '/api/state')).body);
    assert.equal(state.privateGroups, null, 'no reader account: no private-group state');
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
