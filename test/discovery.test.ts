import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from 'telegram';
import { isMembershipNotice } from '../src/reader-client.ts';
import { Reader, type MtClient, type MtEntity, type MtMessage } from '../src/reader.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
const ch = (id: number, title: string, extra: Partial<MtEntity> = {}): MtEntity => ({ className: 'Channel', id, title, megagroup: true, accessHash: `${id}0`, ...extra });
const idOf = (id: number) => -(1_000_000_000_000 + id);

/** The account's chat list, which a test edits between checks. */
class Account implements MtClient {
  dialogs: MtEntity[] = [];
  /** What getDialogs claims the total is (more than returned = a cut-short list). */
  total: number | null = null;
  history = new Map<number, MtMessage[]>();
  pulls: string[] = [];
  async getEntity(): Promise<MtEntity> {
    throw new Error('not used');
  }
  dialogParams: Record<string, unknown>[] = [];
  async getDialogs(params: Record<string, unknown> = {}) {
    this.dialogParams.push(params);
    const list = [...this.dialogs.map((e) => ({ entity: e, title: e.title })), { entity: { className: 'User', id: 1, firstName: 'A friend' }, title: 'A friend' }];
    return Object.assign(list, { total: this.total ?? list.length });
  }
  async getMessages(e: MtEntity, p: { limit?: number; minId?: number; reverse?: boolean; offsetDate?: number }) {
    const all = this.history.get(Number(e.id)) ?? [];
    if (p.offsetDate) return all.filter((m) => m.date < p.offsetDate!).sort((a, b) => b.id - a.id).slice(0, p.limit ?? 100);
    this.pulls.push(String(e.title ?? e.id));
    return all.filter((m) => m.id > (p.minId ?? 0)).sort((a, b) => a.id - b.id).slice(0, p.limit ?? 100);
  }
  inputPeer(p: { type: 'channel' | 'chat'; id: string }): MtEntity {
    const e = this.dialogs.find((d) => String(d.id) === p.id);
    return e ?? { className: 'Channel', id: Number(p.id), title: `#${p.id}` };
  }
}

function setup(autoWatch = true) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const account = new Account();
  const events: { method: string; target: string; detail: string }[] = [];
  const activity = { event: (_a: string, method: string, target: string, detail: string) => events.push({ method, target, detail }) } as never;
  let auto = autoWatch;
  const reader = new Reader({
    client: account,
    store,
    config: testConfig(),
    log: () => undefined,
    now: clock.now,
    pageDelayMs: 0,
    activity,
    discovery: { autoWatch: () => auto, reportTo: 42, defaults: DEFAULTS, noticeGapMs: 5 },
  });
  return { clock, store, account, reader, events, setAuto: (v: boolean) => (auto = v) };
}

const msg = (id: number, date: number, text: string): MtMessage => ({ id, date, message: text, sender: { className: 'User', id: 500, firstName: 'p' } });

test('a group the account joins becomes a source and is read from 24 hours back; people never do', async () => {
  const env = setup();
  const vip = ch(3333, 'Alpha VIP');
  env.account.history.set(3333, [msg(1, T0 - 2 * 86_400, 'old'), msg(2, T0 - 3600, 'recent'), msg(3, T0 - 60, 'now')]);
  env.account.dialogs = [vip, { className: 'ChannelForbidden', id: 4444, title: 'Kicked from' }, { className: 'Chat', id: 55, title: 'Old basic', left: true }];
  const r = await env.reader.reconcile();
  assert.deepEqual(r.added.map((c) => c.title), ['Alpha VIP']);
  const row = env.store.getChat(idOf(3333))!;
  assert.equal(row.kind, 'watched');
  assert.equal(row.enabled, true);
  assert.equal(row.readerOrigin, 'dialog');
  assert.equal(row.reportChatId, 42);
  assert.ok(row.readerPeer, 'its address is saved');
  assert.equal(env.events[0].method, 'new chat');
  await new Promise((r) => setTimeout(r, 20)); // the first pull runs right away
  assert.deepEqual(env.store.messages(idOf(3333), 0, T0 * 2).map((m) => m.text), ['recent', 'now'], '24 hours back, not more');
  assert.equal(env.store.getChat(-4444), null);
  assert.equal(env.store.getChat(-55), null);
  assert.equal(env.store.listChats(false).length, 1, 'no person, no left or forbidden chat');
});

test("GramJS's inverted ignoreMigrated is never used; upgraded basic groups are skipped by their flag", async () => {
  const env = setup();
  env.account.dialogs = [ch(3333, 'Alpha VIP'), { className: 'Channel', id: 9, title: 'A channel', broadcast: true, accessHash: '90' }, { className: 'Chat', id: 77, title: 'Upgraded', deactivated: true }, { className: 'Chat', id: 78, title: 'Basic' }];
  const r = await env.reader.reconcile();
  assert.deepEqual(r.added.map((c) => c.title).sort(), ['A channel', 'Alpha VIP', 'Basic']);
  assert.ok(env.account.dialogParams.every((p) => !p.ignoreMigrated), 'client/dialogs.js:132 keeps ONLY migrated chats when it is set');
});

test('a private chat already watched by id follows the chat list, even if an earlier version labelled it otherwise', async () => {
  const env = setup();
  env.store.watchChat({ chatId: idOf(3333), title: 'Alpha VIP', username: null, type: 'supergroup', ref: String(idOf(3333)) }, 42, null, DEFAULTS);
  env.store.updateChat(idOf(3333), { readerOrigin: 'manual' });
  env.account.dialogs = [ch(3333, 'Alpha VIP')];
  await env.reader.reconcile();
  assert.equal(env.store.getChat(idOf(3333))!.readerOrigin, 'dialog');
});

test('with auto-read off, a new group is listed switched off', async () => {
  const env = setup(false);
  env.account.dialogs = [ch(3333, 'Alpha VIP')];
  await env.reader.reconcile();
  const row = env.store.getChat(idOf(3333))!;
  assert.equal(row.enabled, false);
  assert.equal(env.store.getKv(`reader_off_reason:${idOf(3333)}`), 'auto-watch off');
  assert.deepEqual(env.account.pulls, []);
});

test("the owner's switch sticks: checking the list again never turns back on what was switched off", async () => {
  const env = setup();
  env.account.dialogs = [ch(3333, 'Alpha VIP')];
  await env.reader.reconcile();
  env.store.updateChat(idOf(3333), { enabled: false });
  env.store.setKv(`reader_off_reason:${idOf(3333)}`, 'owner');
  await env.reader.reconcile();
  assert.equal(env.store.getChat(idOf(3333))!.enabled, false);
});

test('leaving takes the source off, with its messages; joining again brings it back; a cut-short list proves nothing', async () => {
  const env = setup();
  env.account.history.set(7777, [msg(1, T0 - 600, 'whale alert')]);
  env.account.dialogs = [ch(3333, 'Alpha VIP'), ch(7777, 'Whales')];
  await env.reader.reconcile();
  await new Promise((r) => setTimeout(r, 20)); // the first pulls
  assert.equal(env.store.messages(idOf(7777), 0, T0 * 2).length, 1);
  env.store.saveDigest({ chatId: idOf(7777), kind: 'production', windowStart: T0 - 86_400, windowEnd: T0, genomeVersion: 0, digest: {} as never, metrics: null });
  env.store.setMembership(idOf(7777), { state: 'member', joinedAt: T0 - 7200, checkedAt: T0 - 7200 });

  // The list comes back cut short (more dialogs than returned): Whales is missing but may just be beyond the cut.
  env.account.dialogs = [ch(3333, 'Alpha VIP')];
  env.account.total = 5000;
  await env.reader.reconcile();
  assert.equal(env.store.getChat(idOf(7777))!.enabled, true);

  // A complete list without Whales: the account left it, so the source goes.
  env.account.total = null;
  const r = await env.reader.reconcile();
  assert.deepEqual(r.left.map((c) => c.title), ['Whales']);
  assert.ok(r.left[0].readerPeer, 'its address goes along, for the membership check that follows');
  assert.equal(env.store.getChat(idOf(7777)), null, 'taken off Sources');
  assert.deepEqual(env.store.messages(idOf(7777), 0, T0 * 2), [], 'with the messages kept for it');
  assert.equal(env.store.getKv(`reader_cursor_date:${idOf(7777)}`), null, 'and its reading state');
  assert.match(env.events.find((e) => e.method === 'left chat')!.detail, /taken off Sources/);
  assert.equal(env.store.recentDigests(10).filter((d) => d.chatId === idOf(7777)).length, 1, 'digests already written stay');
  assert.ok(env.store.membership(idOf(7777)), 'so does the membership record');
  assert.ok(env.store.getChat(idOf(3333)), 'the rest stay');

  // Back in it (and renamed meanwhile): a new chat again, read from up to 24 hours back.
  env.account.dialogs = [ch(3333, 'Alpha VIP'), ch(7777, 'Whale Brothers')];
  const again = await env.reader.reconcile();
  assert.deepEqual(again.added.map((c) => c.title), ['Whale Brothers']);
  assert.equal(env.store.getChat(idOf(7777))!.enabled, true);
});

test('every source the account is no longer in goes, whatever its switch; one still in the list never does', async () => {
  const env = setup();
  env.account.dialogs = [ch(3333, 'Alpha VIP'), ch(7777, 'Whales'), ch(8888, 'Muted one')];
  await env.reader.reconcile();
  env.store.updateChat(idOf(8888), { enabled: false });
  env.store.setKv(`reader_off_reason:${idOf(8888)}`, 'owner');
  // Switched off by an earlier version when the account left it (read by name, so not from the chat list).
  env.store.watchChat({ chatId: idOf(5555), title: 'Gone earlier', username: 'gone_earlier', type: 'supergroup', ref: '@gone_earlier' }, 42, null, DEFAULTS);
  env.store.updateChat(idOf(5555), { enabled: false, readerOrigin: 'manual', readerError: 'no longer a member (left or removed): reading stopped' });
  env.store.setKv(`reader_off_reason:${idOf(5555)}`, 'left');
  // A source the account is still in, though Telegram now restricts it for every client (it cannot be listed as one).
  env.store.watchChat({ chatId: idOf(6666), title: 'Restricted now', username: null, type: 'supergroup', ref: String(idOf(6666)) }, 42, null, DEFAULTS);
  env.store.updateChat(idOf(6666), { readerOrigin: 'dialog' });
  // Read by name from outside: not being in it is normal.
  env.store.watchChat({ chatId: idOf(4444), title: 'Public', username: 'publicgroup', type: 'supergroup', ref: '@publicgroup' }, 42, null, DEFAULTS);
  env.store.updateChat(idOf(4444), { readerOrigin: 'manual' });

  env.account.dialogs = [ch(3333, 'Alpha VIP'), ch(6666, 'Restricted now', { restrictionReason: [{ platform: 'all', reason: 'porn', text: 'Blocked' }] })];
  const r = await env.reader.reconcile();
  assert.deepEqual(r.left.map((c) => c.title).sort(), ['Muted one', 'Whales']);
  assert.deepEqual(
    env.store.listChats(false).map((c) => c.title).sort(),
    ['Alpha VIP', 'Public', 'Restricted now'],
  );
  assert.ok(env.events.some((e) => e.method === 'source removed' && e.target === 'Gone earlier'), 'switched off before because the account had left: it goes too');
});

test('a source added by name is not stopped when it is missing from the chat list (read from outside)', async () => {
  const env = setup();
  env.store.watchChat({ chatId: idOf(1146170349), title: 'Binance English', username: 'binanceexchange', type: 'supergroup', ref: '@binanceexchange' }, 42, null, DEFAULTS);
  env.store.updateChat(idOf(1146170349), { readerOrigin: 'manual' });
  env.account.dialogs = [];
  await env.reader.reconcile();
  assert.equal(env.store.getChat(idOf(1146170349))!.enabled, true);
});

test('switched back on after days: catch-up starts no more than 24 hours back', async () => {
  const env = setup();
  const vip = ch(3333, 'Alpha VIP');
  env.account.dialogs = [vip];
  env.account.history.set(3333, [msg(1, T0 - 60, 'before')]);
  await env.reader.reconcile();
  await new Promise((r) => setTimeout(r, 20));
  // Off for 3 days, a message a day meanwhile.
  env.store.updateChat(idOf(3333), { enabled: false });
  env.account.history.get(3333)!.push(msg(2, T0 + 86_400, 'day 1'), msg(3, T0 + 2 * 86_400 - 60, 'day 2'), msg(4, T0 + 3 * 86_400 - 60, 'day 3'));
  env.clock.t = T0 + 3 * 86_400;
  env.store.updateChat(idOf(3333), { enabled: true });
  env.store.setKv(`reader_floor:${idOf(3333)}`, String(env.clock.t - 86_400)); // what the console switch sets
  await env.reader.pull(env.store.getChat(idOf(3333))!);
  assert.deepEqual(env.store.messages(idOf(3333), 0, T0 * 3).map((m) => m.text), ['before', 'day 3']);
});

test('only notices about the account itself count as membership changes', () => {
  const self = '8000000001';
  const service = (action: Api.TypeMessageAction, from = '999', out = false) =>
    new Api.UpdateNewChannelMessage({
      message: new Api.MessageService({ id: 1, peerId: new Api.PeerChannel({ channelId: 1 as never }), date: T0, action, fromId: new Api.PeerUser({ userId: from as never }), out }),
      pts: 1,
      ptsCount: 1,
    });
  assert.equal(isMembershipNotice(new Api.UpdateChannel({ channelId: 1 as never }), self), true);
  assert.equal(isMembershipNotice(service(new Api.MessageActionChatAddUser({ users: [self as never] })), self), true);
  assert.equal(isMembershipNotice(service(new Api.MessageActionChatAddUser({ users: ['123' as never] })), self), false, 'someone else joining');
  assert.equal(isMembershipNotice(service(new Api.MessageActionChatJoinedByLink({ inviterId: '5' as never }), self), self), true);
  assert.equal(isMembershipNotice(service(new Api.MessageActionChatJoinedByLink({ inviterId: '5' as never }), '777'), self), false);
  assert.equal(isMembershipNotice(service(new Api.MessageActionChatDeleteUser({ userId: self as never })), self), true);
  assert.equal(isMembershipNotice(new Api.UpdateNewChannelMessage({ message: new Api.Message({ id: 2, peerId: new Api.PeerChannel({ channelId: 1 as never }), date: T0, message: 'hi' }), pts: 1, ptsCount: 1 }), self), false);
});

test('a membership notice loads the chat list only when it can mean a join, a leave or a removal', async () => {
  const env = setup();
  const vip = ch(3333, 'Alpha VIP');
  env.account.dialogs = [vip];
  await env.reader.reconcile();
  const loads = () => env.account.dialogParams.length;
  const wait = () => new Promise((r) => setTimeout(r, 40));
  const before = loads();

  env.reader.membershipNotice({ chatId: idOf(3333), entity: { ...vip, title: 'Alpha VIP (new photo)' } });
  await wait();
  assert.equal(loads(), before, 'a routine change to a chat it is in: nothing loaded');

  env.reader.membershipNotice({ chatId: idOf(4444), entity: { className: 'ChannelForbidden', id: 4444 } });
  await wait();
  assert.equal(loads(), before, 'removed from a chat that is not a source: nothing to do');

  env.account.dialogs = [vip, ch(5555, 'Fresh')];
  env.reader.membershipNotice({ chatId: idOf(5555), entity: ch(5555, 'Fresh') });
  env.reader.membershipNotice({ chatId: idOf(5555), entity: ch(5555, 'Fresh') });
  await wait();
  assert.equal(loads(), before + 1, 'a chat that is not a source yet: one load, however many notices');
  assert.equal(env.store.getChat(idOf(5555))!.kind, 'watched');

  env.account.dialogs = [ch(5555, 'Fresh')];
  env.reader.membershipNotice({ chatId: idOf(3333), entity: { ...vip, left: true } });
  await wait();
  assert.equal(loads(), before + 2, 'a source the notice shows it left: checked');
  assert.equal(env.store.getChat(idOf(3333)), null, 'and taken off Sources');

  env.account.dialogs = [vip, ch(5555, 'Fresh')];
  env.reader.membershipNotice({ chatId: idOf(3333), entity: vip });
  await wait();
  assert.equal(loads(), before + 2, 'the same chat again within the hour: the hourly check will see it');
});
