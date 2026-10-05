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
  } finally {
    await server.stop();
  }
});
