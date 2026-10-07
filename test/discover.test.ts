import assert from 'node:assert/strict';
import { test } from 'node:test';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import { assess, impersonation, languageOf, linkedUsernames, scammy, TOPICS, type Found, type Seen } from '../src/discover-rules.ts';
import { Discovery } from '../src/discover.ts';
import type { StoredMessage } from '../src/store.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const HL = TOPICS.hyperliquid;
const OFFICIAL = ['hyperliquid_announcements'];
const found = (over: Partial<Found> = {}): Found => ({ chatId: -1001, title: 'A group', username: 'a_group', type: 'group', members: 5000, verified: false, scam: false, fake: false, restricted: [], via: ['search "hyperliquid"'], mentions: 0, ...over });
let nextId = 1;
const msg = (userId: number, text: string, date = T0): StoredMessage => ({ chatId: -1001, messageId: nextId++, threadId: null, userId, date, text, replyTo: null, reactions: 0, edited: false });
const seen = (sample: StoredMessage[], over: Partial<Seen> = {}): Seen => ({ readable: true, members: 5000, online: null, about: '', perDay: 300, newestAt: T0, sample, botMessages: 0, sampled: sample.length, joinRequest: false, ...over });
const lively = (texts: string[], people = 30) => Array.from({ length: 100 }, (_, i) => msg(1 + (i % people), `${texts[i % texts.length]}，第${i}条`, T0 - 3000 + i * 30));

test('names that claim to be official, support or airdrops, and look-alike spellings, are impersonation', () => {
  assert.match(impersonation({ title: 'Hyperliquid Official Support', username: 'hl_support_desk', verified: false }, HL, OFFICIAL)!, /claims to be hyperliquid's official.*links only @hyperliquid_announcements/);
  assert.match(impersonation({ title: 'Hyperliquid 空投领取', username: null, verified: false }, HL, OFFICIAL)!, /claims/);
  assert.match(impersonation({ title: 'HyperIiquid Traders', username: 'hyperIiquid_traders', verified: false }, HL, OFFICIAL)!, /look-alike/);
  assert.equal(impersonation({ title: 'Hyperliquid 中文社区', username: 'hl_cn', verified: false }, HL, OFFICIAL), null, 'a community using the name claims nothing');
  assert.equal(impersonation({ title: 'Hyperliquid 官方中文群（非官方）', username: null, verified: false }, HL, OFFICIAL), null, 'disclaimed');
  assert.equal(impersonation({ title: 'Hyperliquid Announcements Official', username: 'hyperliquid_announcements', verified: false }, HL, OFFICIAL), null, 'the official handle');
  assert.equal(impersonation({ title: 'Binance Support', username: 'binance_support', verified: true }, TOPICS.crypto, []), null, 'verified by Telegram');
});

test('selling, soliciting and draining read as scams; warnings about them do not', () => {
  assert.ok(scammy('DM me for VIP signals, 100x gems daily'));
  assert.ok(scammy('Airdrop is live, claim now: hyperliquid-claim.xyz'));
  assert.ok(scammy('Please connect your wallet to validate the airdrop'));
  assert.ok(scammy('enter your seed phrase to sync'));
  assert.ok(scammy('稳赚不赔，私聊我带单'));
  assert.ok(!scammy('Never share your seed phrase. Admins will never DM you.'));
  assert.ok(!scammy('HYPE funding is negative again, shorts paying longs'));
});

test('language, and the public usernames a message links to', () => {
  assert.equal(languageOf([{ text: '今天 hyperliquid 的资金费率又是负的，空头在付钱' }, { text: '合约成交量创新高了' }]), 'zh');
  assert.equal(languageOf([{ text: 'funding flipped negative on HYPE again, shorts are paying' }, { text: 'volume is at a new high' }]), 'en');
  assert.equal(languageOf([{ text: 'ok' }]), null);
  assert.deepEqual(linkedUsernames('join t.me/hl_cn_community and https://t.me/perp_news, not t.me/+AbCd, t.me/joinchat/x or t.me/price_bot'), ['hl_cn_community', 'perp_news']);
});

test('a lively community about the topic is good; the same with bought members, one voice, or a closed door is not', () => {
  const talk = ['HYPE 永续资金费率又负了', 'hyperliquid 的 HLP 收益最近怎么样', '合约深度比上周好很多', 'hyperevm 上的新项目有人玩吗', '今天 hyperliquid 成交量很大'];
  const good = assess(found({ title: 'Hyperliquid 中文社区', username: 'hl_cn', mentions: 3 }), seen(lively(talk)), HL, OFFICIAL, T0);
  assert.equal(good.verdict, 'good');
  assert.ok(good.score >= 60);
  assert.equal(good.speakers, 30);
  assert.equal(good.language, 'zh');
  assert.ok(good.good.some((x) => /linked by 3 people/.test(x)));
  assert.ok(good.good.some((x) => /about Hyperliquid/.test(x)));

  const bought = assess(found({ title: 'Hyperliquid Whales', members: 20000 }), seen(lively(talk, 3).slice(0, 12), { members: 20000, perDay: 0.5 }), HL, OFFICIAL, T0);
  assert.ok(bought.bad.some((x) => /members bought, or abandoned/.test(x)));
  assert.notEqual(bought.verdict, 'good');

  const oneVoice = assess(found({ title: 'Hyperliquid alpha' }), seen(Array.from({ length: 40 }, (_, i) => msg(i < 30 ? 1 : 2 + i, talk[i % talk.length]))), HL, OFFICIAL, T0);
  assert.ok(oneVoice.bad.some((x) => /one account writes/.test(x)));

  const empty = assess(found({ title: 'Hyperliquid (channel not active)' }), seen([msg(1, 'hyperliquid')], { sampled: 100, botMessages: 99, perDay: 7 }), HL, OFFICIAL, T0);
  assert.equal(empty.verdict, 'low', 'nobody writes there');
  assert.ok(empty.bad.some((x) => /hardly anyone writes: 1 of its last 100/.test(x)));
  assert.ok(empty.bad.some((x) => /no longer active/.test(x)));
  const flood = assess(found({ title: 'Hyperliquid lending', members: 39 }), seen(Array.from({ length: 100 }, (_, i) => msg(1 + (i % 3), `swap ${i} done`)), { perDay: 4237, members: 39 }), HL, OFFICIAL, T0);
  assert.ok(flood.bad.some((x) => /4,237 messages a day from 3 accounts: bots or spam/.test(x)));
  assert.equal(flood.verdict, 'low');

  const closed = assess(found({ title: 'HL Traders' }), seen([], { readable: false, joinRequest: true }), HL, OFFICIAL, T0);
  assert.equal(closed.verdict, 'closed');
  assert.match(closed.bad[0], /admin to approve/);

  const spam = assess(found({ title: 'Hyperliquid Signals', type: 'channel' }), seen(Array.from({ length: 20 }, () => msg(9, 'VIP signals: 100x gems, DM me to join'))), HL, OFFICIAL, T0);
  assert.equal(spam.verdict, 'scam');
  assert.equal(assess(found({ scam: true }), null, HL, OFFICIAL, T0).verdict, 'scam', "Telegram's own flag");
});

// ── the search itself, against a stand-in Telegram ─────────────────────────

const channel = (id: number, title: string, username: string, over: Record<string, unknown> = {}) =>
  new Api.Channel({ id: bigInt(id), title, username, accessHash: bigInt(id * 7), megagroup: true, date: 0, photo: new Api.ChatPhotoEmpty(), participantsCount: 5000, ...over });

function fakeTelegram(now: number) {
  const CN = channel(11, 'Hyperliquid 中文社区', 'hl_cn_community');
  const SUPPORT = channel(12, 'Hyperliquid Official Support', 'hl_support_desk');
  const VIP = channel(13, 'Hyperliquid VIP Signals', 'hl_vip', { megagroup: false, broadcast: true });
  const DEAD = channel(14, 'Hyperliquid Whales', 'hl_whales', { participantsCount: 20000 });
  const PRIVATE = channel(15, 'HL Traders Private', 'hl_private', { joinRequest: true });
  const FLAGGED = channel(16, 'Hyperliquid Rewards', 'hl_rewards', { scam: true });
  const OURS = channel(17, 'Hyperliquid Announcements', 'hyperliquid_announcements', { megagroup: false, broadcast: true });
  const NEWS = channel(18, 'Perp DEX News', 'perp_dex_news', { megagroup: false, broadcast: true, participantsCount: 40000 });
  const requests: string[] = [];
  const texts: Record<number, { users: number; text: string[]; perDay: number }> = {
    11: { users: 30, text: ['HYPE 永续资金费率又负了', 'hyperliquid 的 HLP 收益最近怎么样', '合约深度比上周好很多', 'hyperevm 上的新项目有人玩吗'], perDay: 400 },
    13: { users: 1, text: ['VIP signals: 100x gems, DM me to join'], perDay: 20 },
    14: { users: 3, text: ['gm', 'hyperliquid pump soon'], perDay: 0 },
    18: { users: 1, text: ['Hyperliquid perp volume hits a record', 'New perp DEX listings this week on hyperliquid'], perDay: 6 },
  };
  const client = {
    async invoke(req: { className: string; q?: string }) {
      requests.push(req.className + (req.q ? ` ${req.q}` : ''));
      if (req.className === 'contacts.Search') return { chats: req.q === 'hyperliquid' ? [CN, SUPPORT, VIP, DEAD, PRIVATE, FLAGGED, OURS] : [] };
      if (req.className === 'channels.GetChannelRecommendations') return { chats: [NEWS] };
      if (req.className === 'channels.GetFullChannel') return { fullChat: { participantsCount: 5000, onlineCount: 10, about: '', botInfo: [] }, users: [] };
      throw new Error(`unexpected ${req.className}`);
    },
    async getEntity(ref: string) {
      requests.push(`getEntity ${ref}`);
      return ref.replace('@', '') === 'hyperliquid_announcements' ? OURS : CN;
    },
    async getMessages(e: Api.Channel, params: { limit?: number; offsetDate?: number }) {
      const id = Number(String(e.id));
      const t = texts[id];
      if (!t) throw Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' });
      if (params.offsetDate) return [new Api.Message({ id: 1000 - t.perDay, peerId: new Api.PeerChannel({ channelId: e.id }), date: params.offsetDate, message: 'x' })];
      return Array.from({ length: 100 }, (_, i) =>
        new Api.Message({ id: 1000 - i, peerId: new Api.PeerChannel({ channelId: e.id }), date: now - (t.perDay ? i * 200 : 30 * 86_400 + i), message: t.users > 1 ? `${t.text[i % t.text.length]}，第${i}条` : t.text[i % t.text.length], fromId: new Api.PeerUser({ userId: bigInt(100 + (i % t.users)) }) }),
      );
    },
  };
  return { client: client as unknown as TelegramClient, requests };
}

test('one search: Telegram search, similar channels and your groups\' links, a look at each, scams set apart', async () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
  store.watchChat({ chatId: -1000000000017, title: 'Hyperliquid Announcements', username: 'hyperliquid_announcements', type: 'channel', ref: '@hyperliquid_announcements' }, 42, null, defaults);
  store.watchChat({ chatId: -1000000000099, title: 'Our Group', username: 'our_group', type: 'supergroup', ref: '@our_group' }, 42, null, defaults);
  for (let i = 0; i < 3; i++) store.saveMessage({ chatId: -1000000000099, messageId: 500 + i, threadId: null, userId: 1 + i, date: T0 - 3600, text: '中文的 hyperliquid 群：t.me/hl_cn_community', replyTo: null, reactions: 0, edited: false });
  const activity = new Activity(store);
  const tg = fakeTelegram(T0);
  const pages: string[] = [];
  const discovery = new Discovery({
    store,
    activity,
    now: clock.now,
    log: () => undefined,
    client: () => tg.client,
    fetch: (async (url: string) => {
      pages.push(String(url));
      return new Response('<a href="https://t.me/hyperliquid_announcements">Telegram</a>');
    }) as typeof fetch,
    pauseMs: 0,
    perHour: 1,
  });
  const started = discovery.start('hyperliquid', null, { actor: 'claude', via: ' · via Claude Code' });
  assert.equal(started.ok, true);
  assert.equal(discovery.start('crypto', null, { actor: 'console', via: '' }).ok, false, 'one at a time');
  for (let i = 0; i < 2000 && discovery.view().running; i++) await new Promise((r) => setTimeout(r, 5));
  const [run] = discovery.view().latest;
  assert.equal(run.error, null);
  assert.deepEqual(pages, ['https://hyperliquid.xyz'], "the project's own site, for its official handles");
  const verdicts = Object.fromEntries(run.results.map((r) => [r.username, r.verdict]));
  assert.deepEqual(verdicts, { hl_cn_community: 'good', perp_dex_news: verdicts.perp_dex_news, hl_whales: 'low', hl_private: 'closed', hl_support_desk: 'scam', hl_rewards: 'scam', hl_vip: 'scam' });
  assert.ok(['good', 'ok'].includes(verdicts.perp_dex_news), 'a similar channel Telegram suggested');
  assert.ok(!('hyperliquid_announcements' in verdicts), 'what is already read is left out');
  assert.match(run.notes.join(' '), /1 of what was found you already read: Hyperliquid Announcements/);
  const cn = run.results.find((r) => r.username === 'hl_cn_community')!;
  assert.ok(cn.via.includes('search "hyperliquid"'));
  assert.ok(cn.good.some((x) => /linked by 3 people in your groups/.test(x)));
  assert.equal(run.results[0].username, 'hl_cn_community', 'the best first');
  assert.ok(!tg.requests.some((r) => /hl_support_desk|hl_rewards/.test(r)), 'no look at what its name or Telegram already gives away');
  assert.equal(tg.requests.filter((r) => r.startsWith('contacts.Search')).length, HL.queries.length);
  assert.ok(tg.requests.every((r) => !/Join|Send|Import/.test(r)), 'nothing but reads');
  const rows = store.activity({ actor: 'claude' }).map((r) => r.method);
  assert.deepEqual(rows, ['find groups', 'groups found']);
  assert.equal(discovery.start('crypto', null, { actor: 'console', via: '' }).ok, false, 'rationed');
  assert.deepEqual(discovery.dismiss(-1000000000011), { ok: true, message: 'Hidden from future searches.' });
});
