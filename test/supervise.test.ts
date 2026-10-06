import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import { acquireSessionLock, superviseRequests } from '../src/reader-client.ts';
import { peerOf, Reader, type MtClient, type MtEntity } from '../src/reader.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

function fakeGram(handler: (req: { className: string }) => Promise<unknown>) {
  const calls: { className: string; at: number }[] = [];
  const client = {
    invoke: async (req: { className: string }) => {
      calls.push({ className: req.className, at: Date.now() });
      return handler(req);
    },
    invokeWithSender: async (req: { className: string }) => handler(req),
  };
  return { client: client as unknown as TelegramClient & { invoke: (r: unknown) => Promise<unknown> }, calls };
}

test('every request is paced account-wide; upkeep requests are not', async () => {
  const store = memoryStore(new Clock());
  const { client, calls } = fakeGram(async () => ({ messages: [] }));
  superviseRequests(client, new Activity(store), () => null, { intervalMs: 40, burst: 2 });
  const started = Date.now();
  await Promise.all(Array.from({ length: 6 }, () => client.invoke({ className: 'messages.GetHistory' })));
  const took = Date.now() - started;
  assert.ok(took >= 4 * 40 - 15, `6 requests with a burst of 2 at 40ms each take at least ~160ms, took ${took}`);
  await client.invoke({ className: 'help.GetConfig' });
  assert.equal(calls.length, 7);
  assert.equal(store.activity().filter((a) => a.kind === 'read').length, 6, 'reads recorded; upkeep not');
});

test('a FLOOD_WAIT holds every request, is recorded, and a short one is waited out and retried once', async () => {
  const store = memoryStore(new Clock());
  let first = true;
  const { client, calls } = fakeGram(async (req) => {
    if (req.className === 'messages.GetHistory' && first) {
      first = false;
      throw Object.assign(new Error('FLOOD_WAIT_1'), { errorMessage: 'FLOOD_WAIT', seconds: 1 });
    }
    return { messages: [1, 2] };
  });
  const sup = superviseRequests(client, new Activity(store), () => null, { intervalMs: 1, burst: 10 });
  const started = Date.now();
  const [a, b] = await Promise.all([
    client.invoke({ className: 'messages.GetHistory' }),
    new Promise((r) => setTimeout(r, 20)).then(() => client.invoke({ className: 'channels.GetFullChannel' })),
  ]);
  assert.deepEqual(a, { messages: [1, 2] }, 'retried after the wait');
  assert.ok(b);
  const full = calls.find((c) => c.className === 'channels.GetFullChannel')!;
  assert.ok(full.at - started >= 1000, 'the other request waited for the account-wide pause too');
  assert.ok(sup.pausedUntil() > started);
  const wait = store.activity().find((x) => x.detail.startsWith('FLOOD_WAIT 1s'));
  assert.ok(wait && !wait.ok, 'the wait is in the activity log');
});

test('a long FLOOD_WAIT is not retried: it surfaces with its seconds', async () => {
  const store = memoryStore(new Clock());
  const { client } = fakeGram(async () => {
    throw Object.assign(new Error('FLOOD_WAIT_3600'), { errorMessage: 'FLOOD_WAIT', seconds: 3600 });
  });
  const sup = superviseRequests(client, new Activity(store), () => null);
  await assert.rejects(client.invoke({ className: 'contacts.ResolveUsername' }), (e: { seconds?: number }) => e.seconds === 3600);
  assert.ok(sup.pausedUntil() - Date.now() > 3_500_000);
});

test('one process per session: a live holder blocks a second connection; a stale lock is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-lock-'));
  const session = join(dir, 'reader.session');
  writeFileSync(`${session}.lock`, String(process.ppid)); // the test runner's parent: alive
  assert.throws(() => acquireSessionLock(session), /in use by process/);
  writeFileSync(`${session}.lock`, '999999'); // no such process
  const lock = acquireSessionLock(session);
  lock.release();
  assert.equal(existsSync(`${session}.lock`), false);
});

test("a watched chat's address is saved, so after a restart it is read without resolving its name", async () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const group: MtEntity = { className: 'Channel', id: 1136071376, title: 'Binance 中文', username: 'binancechinese', megagroup: true, accessHash: '-123456789' };
  assert.equal(peerOf(group), JSON.stringify({ type: 'channel', id: '1136071376', accessHash: '-123456789' }));
  assert.equal(peerOf({ ...group, min: true }), null, 'a min access hash is not reusable');
  let resolves = 0;
  const built: unknown[] = [];
  const client: MtClient = {
    getEntity: async () => {
      resolves++;
      return group;
    },
    getDialogs: async () => [],
    getMessages: async () => [],
    inputPeer: (p) => {
      built.push(p);
      return { className: 'InputPeerChannel', id: p.id };
    },
  };
  const reader = new Reader({ client, store, config: testConfig(), log: () => undefined, now: clock.now, pageDelayMs: 0 });
  const info = await reader.resolve('@binancechinese');
  store.watchChat(info, 42, null, { language: 'auto', digestHour: 9, timezone: 'UTC', rsiMode: 'auto' });
  assert.equal(resolves, 1);
  const again = new Reader({ client, store, config: testConfig(), log: () => undefined, now: clock.now, pageDelayMs: 0 });
  await again.pull(store.getChat(-1001136071376)!);
  assert.equal(resolves, 1, 'no second resolve after the restart');
  assert.deepEqual(built, [{ type: 'channel', id: '1136071376', accessHash: '-123456789' }]);
});

test('a chat Telegram restricts for every client is refused, not read', async () => {
  const store = memoryStore(new Clock(T0));
  const client: MtClient = {
    getEntity: async () => ({ className: 'Channel', id: 5, title: 'x', megagroup: true, restrictionReason: [{ platform: 'all', reason: 'porn', text: 'This group is blocked' }] }),
    getDialogs: async () => [],
    getMessages: async () => [],
  };
  const reader = new Reader({ client, store, config: testConfig(), log: () => undefined, now: () => T0 });
  await assert.rejects(reader.resolve('@somegroup'), /restricts this chat for every client \(porn/);
});

test('an invite check is never retried by the door (a flood there pauses invite checks instead); history still is', async () => {
  const store = memoryStore(new Clock());
  const sent: string[] = [];
  const { client } = fakeGram(async (req) => {
    sent.push(req.className);
    if (sent.filter((c) => c === req.className).length === 1) throw Object.assign(new Error('FLOOD_WAIT_1'), { errorMessage: 'FLOOD_WAIT', seconds: 1 });
    return { messages: [] };
  });
  superviseRequests(client, new Activity(store), () => null, { intervalMs: 1, burst: 10 });
  await assert.rejects(client.invoke({ className: 'messages.CheckChatInvite' }), (e: { seconds?: number }) => e.seconds === 1);
  assert.deepEqual(sent, ['messages.CheckChatInvite'], 'one request, no retry');
  await client.invoke({ className: 'messages.GetHistory' });
  assert.deepEqual(sent, ['messages.CheckChatInvite', 'messages.GetHistory', 'messages.GetHistory'], 'a history read still waits and retries once');
});
