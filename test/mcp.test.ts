// The MCP server end to end: the real server (src/mcp.ts) in a child process, an MCP client
// talking to it over stdio the way Claude Desktop and Claude Code do, and a console in this process
// standing in for the running service. Its own temporary database: nothing real is touched.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Activity } from '../src/activity.ts';
import { ConsoleServer } from '../src/console/server.ts';
import type { Notice } from '../src/notify.ts';
import { Store, type StoredMessage } from '../src/store.ts';
import { testConfig } from './helpers.ts';

const PUBLIC = -1001111111111;
const PRIVATE = -1002222222222;
const OFF = -1003333333333;
const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'Asia/Shanghai', rsiMode: 'auto' as const };

type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
};

test('the MCP server: every tool, prompt and resource an agent uses, with what it does recorded as Claude\'s', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-mcp-'));
  const dbPath = join(dir, 'pulse.db');
  const now = Math.floor(Date.now() / 1000); // the child runs on the real clock
  // One fixed second for what this side records: the three sources are added in the same second,
  // so they are numbered by chat id (OFF #1, PRIVATE #2, PUBLIC #3) every run.
  const store = new Store(dbPath, () => now);
  store.watchChat({ chatId: PUBLIC, title: 'Public Group', username: 'public_group', type: 'supergroup', ref: '@public_group' }, 42, null, defaults);
  store.watchChat({ chatId: OFF, title: 'Switched Off', username: null, type: 'supergroup', ref: String(OFF) }, 42, null, defaults);
  store.watchChat({ chatId: PRIVATE, title: 'Private Group', username: null, type: 'supergroup', ref: String(PRIVATE) }, 42, null, defaults);
  store.updateChat(OFF, { enabled: false });
  store.setKv(`reader_off_reason:${OFF}`, 'owner');
  for (const chatId of [PUBLIC, PRIVATE, OFF]) {
    store.upsertUser(chatId, 1, 'Alice', 'alice');
    store.upsertUser(chatId, 2, 'Bob', null);
  }
  const save = (chatId: number, messageId: number, date: number, text: string, over: Partial<StoredMessage> = {}) =>
    store.saveMessage({ chatId, messageId, threadId: null, userId: 1, date, text, replyTo: null, reactions: 0, edited: false, ...over });
  save(PUBLIC, 1, now - 3600, 'BTC 突破 10 万了，大家怎么看这一波');
  save(PUBLIC, 2, now - 3000, 'ZEC 也在涨，隐私币要起飞', { userId: 2, replyTo: 1 });
  save(PRIVATE, 7, now - 1800, 'zcash 今天的新闻看了吗');
  const activity = new Activity(store);
  activity.event('news', 'news in the group', 'Public Group', '5 messages from 4 people about BTC, right after Bloomberg reported it');

  const notices: Notice[] = [];
  const config = testConfig({ reportTo: 700000001, dbPath, notify: true });
  const consoleServer = new ConsoleServer({
    store,
    activity,
    config,
    port: 0,
    now: () => Math.floor(Date.now() / 1000),
    log: () => undefined,
    startedAt: now,
    account: null,
    reader: null,
    bot: null,
    claude: { ready: false, model: config.model },
    handoffFile: join(dir, 'console.json'),
    notifier: { notify: (n) => notices.push(n) },
    tailMs: 100,
  });
  try {
    await consoleServer.start();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return t.skip('this sandbox does not allow listening on a local port');
    throw err;
  }
  const port = Number(new URL(consoleServer.url).port);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp.ts'],
    env: { ...getDefaultEnvironment(), PULSE_DB: dbPath, PULSE_TIMEZONE: 'Asia/Shanghai', PULSE_MCP_POLL_MS: '150' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-code', version: 'test' });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? '', /whats_new gives everything stored since your last look/);

    const tools = (await client.listTools()).tools.map((x) => x.name);
    for (const name of ['find_groups', 'hot_terms', 'status', 'whats_new', 'read_messages', 'get_messages', 'overview', 'search_messages', 'get_playbook', 'save_digest', 'past_digests', 'news_keywords', 'news_in_group', 'refresh_news', 'alerts', 'flag_for_owner', 'account_activity', 'check_group', 'list_account_chats', 'invite_status', 'watch_source', 'catch_up_now', 'set_monitoring', 'refresh_sources', 'audit_capture', 'list_sources']) {
      assert.ok(tools.includes(name), `tool ${name}`);
    }
    assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name).sort(), ['daily_digest', 'health_check', 'news_brief', 'whats_new']);
    const prompt = await client.getPrompt({ name: 'daily_digest', arguments: { source: '#3' } });
    assert.match(String((prompt.messages[0].content as { text: string }).text), /the source "#3"[\s\S]*save_digest/);
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    for (const uri of ['telegram-monitor://status', 'telegram-monitor://alerts', 'telegram-monitor://sources', `telegram-monitor://playbook/${PUBLIC}`]) assert.ok(resources.includes(uri), uri);
    const templates = (await client.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate);
    assert.deepEqual(templates.sort(), ['telegram-monitor://digest/{id}', 'telegram-monitor://playbook/{chatId}']);

    // status: one call, typed; #n numbers every source, switched-off ones too.
    const status = await call('status');
    const s = status.structuredContent as { service: { running: boolean }; sources: { n: number; title: string; on: boolean; offReason: string | null }[] };
    assert.equal(s.service.running, true);
    assert.deepEqual(s.sources.map((x) => [x.n, x.title, x.on]), [[1, 'Switched Off', false], [2, 'Private Group', true], [3, 'Public Group', true]]);
    assert.equal(s.sources[0].offReason, 'switched off by the owner');
    assert.match(textOf(status), /#3 Public Group \(@public_group\)/);
    const statusResource = await client.readResource({ uri: 'telegram-monitor://status' });
    assert.equal(JSON.parse(String((statusResource.contents[0] as { text: string }).text)).sources.length, 3);

    // #n means the same source in every tool.
    const read = await call('read_messages', { source: '#3', view: 'all' });
    assert.match(textOf(read), /^Public Group · [\s\S]*message links: https:\/\/t\.me\/public_group\/<id>[\s\S]*\[#2 \d\d:\d\d Bob ↩1\] ZEC/);
    const off = await call('read_messages', { source: '#1' });
    assert.equal(off.isError, true);
    assert.match(textOf(off), /Switched Off is switched off/);

    // whats_new: a place per reader; what a catch-up stores later is new even when it is old.
    const first = textOf(await call('whats_new', { reader: 'test', view: 'all' }));
    assert.match(first, /first look for "test"/);
    assert.match(first, /## Private Group · 1 new[\s\S]*## Public Group · 2 new/);
    assert.match(textOf(await call('whats_new', { reader: 'test' })), /Nothing new since your last look/);
    save(PUBLIC, 3, now - 20 * 3600, '停机期间的旧消息，现在才补到');
    const late = textOf(await call('whats_new', { reader: 'test', view: 'all' }));
    assert.match(late, /## Public Group · 1 new[\s\S]*\[#3 [^\]]*\] 停机期间/);
    assert.match(textOf(await call('whats_new', { reader: 'other', view: 'all', peek: true })), /3 messages in 2 groups|4 messages in 2 groups/);

    // search across the groups, with links to open each message.
    const found = textOf(await call('search_messages', { query: 'zec | zcash' }));
    assert.match(found, /2 messages in 2 groups/);
    assert.match(found, /\[Private Group · #7 [^\]]*\] zcash.*https:\/\/t\.me\/c\/2222222222\/7/);
    assert.match(found, /\[Public Group · #2 [^\]]*Bob\] ZEC.*https:\/\/t\.me\/public_group\/2/);
    assert.match(textOf(await call('search_messages', { query: 'zec|zcash', author: 'bob' })), /^1 message in 1 group/);

    // a message with its thread.
    const ctx = textOf(await call('get_messages', { source: 'Public Group', ids: [2, 404] }));
    assert.match(ctx, /  \[#1 [^\]]*Alice\] BTC[\s\S]*▶ \[#2 [^\]]*\] ZEC.* https:\/\/t\.me\/public_group\/2/);
    assert.match(ctx, /Not stored [^\n]*#404/);

    // The console's live stream carries Claude's reads, though another process wrote them.
    const streamed = new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          if (/"kind":"agent","method":"overview"/.test(buf)) {
            req.destroy();
            resolve(buf);
          }
        });
      });
      req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    await call('overview', { source: '#3' });
    assert.match(await streamed, /"actor":"claude"/);
    const reads = store.activity({ kind: 'agent', actor: 'claude' });
    assert.ok(reads.some((r) => r.method === 'read_messages' && r.target === 'Public Group' && /via Claude Code$/.test(r.detail)), 'each read is recorded as Claude\'s, with the app');

    // What Claude changes through the console is recorded as Claude's, and stays put.
    assert.match(textOf(await call('set_monitoring', { source: '#2', on: false })), /Private Group: off/);
    assert.equal(store.getChat(PRIVATE)!.enabled, false);
    assert.equal(store.getKv(`reader_off_reason:${PRIVATE}`), 'claude');
    const switched = store.activity({ actor: 'claude' }).find((r) => r.method === 'switched off');
    assert.ok(switched && /via Claude Code$/.test(switched.detail));
    assert.equal(store.activity({ actor: 'console' }).length, 0, 'nothing of Claude\'s is shown as the owner\'s');
    await call('set_monitoring', { source: '#2', on: true });

    // flag_for_owner: the note in the console, a notification in our own words, a few an hour.
    const flagged = textOf(await call('flag_for_owner', { note: 'A deadline tomorrow: the airdrop snapshot is at 08:00.', source: '#3', ids: [1, 2] }));
    const darwin = process.platform === 'darwin';
    assert.match(flagged, darwin ? /a notification tells the owner/ : /Notifications are off/);
    const row = store.activity({ actor: 'claude' }).find((r) => r.method === 'flagged')!;
    assert.equal(row.target, 'Public Group');
    assert.match(row.detail, /^A deadline tomorrow: the airdrop snapshot is at 08:00\. · #1 #2 · via Claude Code$/);
    if (darwin) {
      assert.equal(notices.length, 1);
      assert.deepEqual(notices[0], { kind: 'flag', group: null, body: 'Claude left you a note in the console (Activity).' }, 'no group title: Claude chose the group, and a title is text others wrote');
      for (let i = 0; i < 3; i++) await call('flag_for_owner', { note: `note ${i}` });
      assert.match(textOf(await call('flag_for_owner', { note: 'one too many' })), /No notification: 4 were shown in the last hour/);
      assert.equal(notices.length, 4);
    }

    // alerts: since the reader's last look; the radar's alert and the flag are there, once.
    const alerts = (await call('alerts', { reader: 'test' })).structuredContent as { alerts: { kind: string; group: string | null }[] };
    assert.deepEqual(alerts.alerts.slice(0, 2).map((a) => [a.kind, a.group]), [['news-hot', 'Public Group'], ['flag', 'Public Group']]);
    assert.equal(((await call('alerts', { reader: 'test' })).structuredContent as { alerts: unknown[] }).alerts.length, 0);
    assert.match(textOf(await call('whats_new', { reader: 'test' })), /Alerts: nothing new/);

    // Digests: saved, listed, read back; the playbook asks for links and for yesterday's stories.
    assert.match(textOf(await call('get_playbook', { source: '#3' })), /\[#id\]\(https:\/\/t\.me\/public_group\/id\)[\s\S]*past_digests/);
    const saved = textOf(await call('save_digest', { source: '#3', markdown: '## Topics\n- BTC at 100k [#1](https://t.me/public_group/1)' }));
    const id = Number(/digest #(\d+)/.exec(saved)?.[1]);
    assert.ok(id > 0, saved);
    assert.match(saved, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the file goes next to the database');
    assert.match(textOf(await call('past_digests', { source: '#3' })), new RegExp(`#${id} · kept .* · Public Group · \\d{4}-`));
    assert.match(textOf(await call('past_digests', { id })), /BTC at 100k \[#1\]\(https:\/\/t\.me\/public_group\/1\)/);
    const digestResource = await client.readResource({ uri: `telegram-monitor://digest/${id}` });
    assert.match(String((digestResource.contents[0] as { text: string }).text), /BTC at 100k/);

    // Short-term high-frequency terms: found in the messages, nobody names them in advance.
    for (let i = 0; i < 9; i++) store.upsertUser(PUBLIC, 10 + i, `Trader ${i}`, null);
    for (let i = 0; i < 9; i++) save(PUBLIC, 100 + i, now - 1200 + i * 60, `币安提现不了，卡了${i}分钟`, { userId: 10 + i });
    const hot = textOf(await call('hot_terms', { minutes: 30 }));
    assert.match(hot, /^币安提现不了，卡了 · Public Group · 9 messages from 9 people in 30 min \(almost never, ×10\.0\) · since [^·]+ · #100 #101 #102 #103 #104 · https:\/\/t\.me\/public_group\/100$/m);
    const { TermWatch } = await import('../src/term-watch.ts');
    assert.equal(new TermWatch({ store, activity, now: () => now }).check().length, 1);
    const burst = (await call('alerts', { reader: 'test' })).structuredContent as { alerts: { kind: string; group: string | null; text: string }[] };
    assert.deepEqual(burst.alerts.map((a) => [a.kind, a.group]), [['term-burst', 'Public Group']]);
    assert.match(textOf(await call('hot_terms', { source: '#3' })), /Raised by the monitor in the last 24h[^\n]*\n  [^\n]+ · Public Group · "币安提现不了，卡了": 9 messages from 9 people/);

    // Finding groups needs the reader account (this stand-in console has none).
    const finding = await call('find_groups', { topic: 'hyperliquid' });
    assert.equal(finding.isError, true);
    assert.match(textOf(finding), /reader account is not signed in/);
    assert.equal((await call('find_groups', {})).isError, true, 'a topic or a query');

    // A subscribed resource is announced when it changes.
    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updated.push(n.params.uri));
    await client.subscribeResource({ uri: 'telegram-monitor://sources' });
    store.updateChat(PUBLIC, { readerError: 'FLOOD_WAIT_30' });
    assert.ok(await until(() => updated.includes('telegram-monitor://sources'), 5000), 'the sources resource was announced as updated');

    const log = textOf(await call('account_activity', { kind: 'agent', limit: 5 }));
    assert.match(log, /AGENT claude /);
    // Paging on from an id gives the rows right after it, oldest first.
    const firstId = store.activity({ limit: 1, next: true })[0].id;
    const page = textOf(await call('account_activity', { after_id: firstId, limit: 2 }));
    assert.deepEqual([...page.matchAll(/^(\d+) /gm)].map((m) => Number(m[1])), [firstId + 1, firstId + 2]);
    assert.match(page, new RegExp(`More: call again with after_id ${firstId + 2}\\.`));
  } finally {
    await client.close().catch(() => undefined);
    await consoleServer.stop();
    store.close();
  }
});
