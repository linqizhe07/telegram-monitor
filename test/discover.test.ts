import assert from 'node:assert/strict';
import { test } from 'node:test';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import {
  assess,
  assessPrivate,
  describedUsernames,
  impersonation,
  inviteHashes,
  languageOf,
  linkedUsernames,
  perDayOf,
  portalPost,
  scammy,
  TOPICS,
  typicalViews,
  type Found,
  type Seen,
} from '../src/discover-rules.ts';
import { Discovery } from '../src/discover.ts';
import type { StoredMessage } from '../src/store.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const HL = TOPICS.hyperliquid;
const OFFICIAL = ['hyperliquid_announcements'];
const DAY = 86_400;
const found = (over: Partial<Found> = {}): Found => ({ chatId: -1001, title: 'A group', username: 'a_group', type: 'group', members: 5000, verified: false, scam: false, fake: false, restricted: [], via: ['search "hyperliquid"'], mentions: 0, ...over });
let nextId = 1;
const msg = (userId: number, text: string, date = T0): StoredMessage => ({ chatId: -1001, messageId: nextId++, threadId: null, userId, date, text, replyTo: null, reactions: 0, edited: false });
const seen = (sample: StoredMessage[], over: Partial<Seen> = {}): Seen => ({ readable: true, members: 5000, online: null, about: '', perDay: 300, newestAt: T0, sample, botMessages: 0, sampled: sample.length, joinRequest: false, ...over });
const lively = (texts: string[], people = 30) => Array.from({ length: 100 }, (_, i) => msg(1 + (i % people), `${texts[i % texts.length]}，第${i}条`, T0 - 3000 + i * 30));
const talk = ['HYPE 永续资金费率又负了', 'hyperliquid 的 HLP 收益最近怎么样', '合约深度比上周好很多', 'hyperevm 上的新项目有人玩吗', '今天 hyperliquid 成交量很大'];

test('names that claim to be official, support or airdrops, and look-alike spellings, are impersonation', () => {
  assert.match(impersonation({ title: 'Hyperliquid Official Support', username: 'hl_support_desk', verified: false }, HL, OFFICIAL)!, /claims to be hyperliquid's official.*links only @hyperliquid_announcements/);
  assert.match(impersonation({ title: 'Hyperliquid 空投领取', username: null, verified: false }, HL, OFFICIAL)!, /claims/);
  assert.match(impersonation({ title: 'HyperIiquid Traders', username: 'hyperIiquid_traders', verified: false }, HL, OFFICIAL)!, /look-alike/);
  assert.equal(impersonation({ title: 'Hyperliquid 中文社区', username: 'hl_cn', verified: false }, HL, OFFICIAL), null, 'a community using the name claims nothing');
  assert.equal(impersonation({ title: 'Hyperliquid 官方中文群（非官方）', username: null, verified: false }, HL, OFFICIAL), null, 'disclaimed');
  assert.equal(impersonation({ title: 'Hyperliquid Announcements Official', username: 'hyperliquid_announcements', verified: false }, HL, OFFICIAL), null, 'the official handle');
  assert.equal(impersonation({ title: 'Binance Support', username: 'binance_support', verified: true }, TOPICS.crypto, []), null, 'verified by Telegram');
});

test('selling, soliciting and draining read as scams, links behind text and buttons too; warnings about them do not', () => {
  assert.ok(scammy('DM me for VIP signals, 100x gems daily'));
  assert.ok(scammy('Airdrop is live, claim now: hyperliquid-claim.xyz'));
  assert.ok(scammy('Please connect your wallet to validate the airdrop'));
  assert.ok(scammy('enter your seed phrase to sync'));
  assert.ok(scammy('稳赚不赔，私聊我带单'));
  assert.ok(scammy('Your HYPE reward is ready 🎁 https://hyperliquid-claim.xyz/s/123'), 'a drainer site names itself after what it promises');
  assert.ok(!scammy('Never share your seed phrase. Admins will never DM you.'));
  assert.ok(!scammy('HYPE funding is negative again, shorts paying longs'));
  assert.ok(!scammy('Staking guide: https://app.hyperliquid.xyz/staking'), 'a path on the real site is not a drainer');
});

test('"verify you are human" portals: a button to an outside bot or site, not the checks real groups answer inside', () => {
  assert.ok(portalPost('Verify you are human to enter the HYPE chat', ['Tap to verify'], ['https://t.me/hype_safeguard_bot?start=join']));
  assert.ok(portalPost('Safeguard: this group is protected', ['Click here'], ['https://hype-verify.app/login']));
  assert.ok(portalPost('人机验证后进群', ['点击验证'], ['https://t.me/Hl_Guard_bot']));
  assert.ok(!portalPost('Verify you are human', ['I am human'], []), 'a button that answers inside the group links nowhere');
  assert.ok(!portalPost('Verify your holdings to join the holders chat', ['Verify'], ['https://connect.collab.land/verify?id=1']), 'a verification service real communities use');
  assert.ok(!portalPost('Hyperliquid funding is negative', ['Chart'], ['https://app.hyperliquid.xyz']), 'a button without a verify word');
});

test('language, the usernames a message or a description points to, and invite links', () => {
  assert.equal(languageOf([{ text: '今天 hyperliquid 的资金费率又是负的，空头在付钱' }, { text: '合约成交量创新高了' }]), 'zh');
  assert.equal(languageOf([{ text: 'funding flipped negative on HYPE again, shorts are paying' }, { text: 'volume is at a new high' }]), 'en');
  assert.equal(languageOf([{ text: 'ok' }]), null);
  assert.deepEqual(linkedUsernames('join t.me/hl_cn_community and https://t.me/perp_news, not t.me/+AbCd, t.me/joinchat/x or t.me/price_bot'), ['hl_cn_community', 'perp_news']);
  assert.deepEqual(describedUsernames('Daily notes. Chat: @hl_daily_chat · news t.me/hl_news · helper @hl_helper_bot · mail me@hl.xyz · contact @hl_founder'), ['hl_news', 'hl_daily_chat']);
  assert.deepEqual(describedUsernames('Hyperliquid 中文资讯。交流群：@hl_cn_chat，商务联系 @hl_bd'), ['hl_cn_chat']);
  assert.deepEqual(inviteHashes('私密群 t.me/+HlPrivAlpha1 和 https://t.me/joinchat/HlOldAlpha22 · too short t.me/+abc'), ['HlPrivAlpha1', 'HlOldAlpha22']);
});

test('messages a day: the last week when the sample reaches back that far, otherwise the time it covers', () => {
  const now = T0;
  const week = Array.from({ length: 100 }, (_, i) => ({ id: 1000 - i, date: now - i * 3 * 3600 })); // one every 3 hours, 12.5 days back
  assert.equal(perDayOf(week, now), 56 / 7, 'the 56 messages of the last week');
  const busy = Array.from({ length: 100 }, (_, i) => ({ id: 5000 - i * 2, date: now - i * 60 })); // a message a minute, every other one deleted
  assert.equal(Math.round(perDayOf(busy, now)), Math.round((199 * DAY) / 5940), 'by message ids, so deleted ones count');
  const young = Array.from({ length: 12 }, (_, i) => ({ id: 12 - i, date: now - i * 600 }));
  assert.equal(perDayOf(young, now), 12, 'a chat with only 12 messages, all from the last two hours: spread over a day');
  assert.equal(perDayOf([], now), 0);
  const holes = busy.map((m, i) => (i % 10 === 5 ? { id: m.id } : m)); // ten deleted ones, without a date
  assert.equal(Math.round(perDayOf(holes, now)), Math.round((199 * DAY) / 5940), 'a full page with deleted messages is still a full page');
  const posts = [100, 120, 90, 4000, 110, 95, 105].map((views, i) => ({ date: now - (i + 1) * 8 * 3600, views }));
  assert.equal(typicalViews([{ date: now - 600, views: 3 }, ...posts], now), 105, 'the median, without the post still gathering views');
  assert.equal(typicalViews(posts.slice(0, 4), now), null, 'too few posts');
});

test('a lively community about the topic is good; the same with bought members, one voice, or a closed door is not', () => {
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

test('members nobody opens, subscribers who never see a post, a month of silence, portals and hidden drainer links', () => {
  const ghosts = assess(found({ title: 'Hyperliquid 中文社区', members: 20000 }), seen(lively(talk), { members: 20000, online: 3 }), HL, OFFICIAL, T0);
  assert.ok(ghosts.bad.some((x) => /20,000 members but 3 online: members bought, or nobody opens it/.test(x)));
  assert.notEqual(ghosts.verdict, 'good');
  const awake = assess(found({ title: 'Hyperliquid 中文社区' }), seen(lively(talk), { online: 600 }), HL, OFFICIAL, T0);
  assert.ok(awake.good.some((x) => /600 of 5,000 members online/.test(x)));
  assert.equal(awake.online, 600);

  const posts = (views: number) => Array.from({ length: 30 }, (_, i) => msg(-1001, `Hyperliquid perp volume note #${i}`, T0 - i * 4 * 3600));
  const boughtSubs = assess(found({ title: 'Hyperliquid News', type: 'channel', members: 40000 }), seen(posts(120), { members: 40000, perDay: 6, views: 120 }), HL, OFFICIAL, T0);
  assert.ok(boughtSubs.bad.some((x) => /40,000 subscribers but a post is seen by about 120: subscribers bought/.test(x)));
  const read = assess(found({ title: 'Hyperliquid News', type: 'channel', members: 40000 }), seen(posts(8000), { members: 40000, perDay: 6, views: 8000 }), HL, OFFICIAL, T0);
  assert.ok(read.good.some((x) => /a post is seen by about 8,000 \(20% of subscribers\)/.test(x)));

  const feed = Array.from({ length: 100 }, (_, i) => msg(-1001, `Hyperliquid big trade #${i}`, T0 - 43 * DAY - i * 600));
  const silent = assess(found({ title: 'Hyperliquid Big Trades Feed', type: 'channel', members: 8643 }), seen(feed, { members: 8643, perDay: 0, newestAt: T0 - 43 * DAY }), HL, OFFICIAL, T0);
  assert.equal(silent.verdict, 'low', 'silent for 43 days: not worth a look, however on-topic');
  const quiet = assess(found({ title: 'Ghost666 - Hyperliquid Chat', members: 137 }), seen(lively(talk), { members: 137, perDay: 0, newestAt: T0 - 19 * DAY }), HL, OFFICIAL, T0);
  assert.equal(quiet.verdict, 'low', 'a group two weeks without a word');
  const alone = assess(found({ title: 'Perpy Traders', members: 6, discusses: 'perpyxyz' }), seen(Array.from({ length: 40 }, (_, i) => msg(1, `hyperliquid perp idea ${i}`)), { members: 6, perDay: 5 }), HL, OFFICIAL, T0);
  assert.equal(alone.verdict, 'low');
  assert.ok(alone.bad.includes('only one account writes there: not a conversation'));

  const portal = assess(found({ title: 'HYPE Portal' }), seen([msg(5, 'Verify you are human'), msg(6, 'gm')], { portal: { posts: 1, others: 1 } }), HL, OFFICIAL, T0);
  assert.equal(portal.verdict, 'scam');
  assert.match(portal.bad.join(' '), /verify you are human" button to an outside bot or site/);
  const warned = assess(found({ title: 'Hyperliquid 中文社区' }), seen(lively(talk), { portal: { posts: 1, others: 99 } }), HL, OFFICIAL, T0);
  assert.notEqual(warned.verdict, 'scam', 'a lively group with one such post is not a portal');
  assert.ok(warned.bad.some((x) => /never press those/.test(x)));

  const drops = Array.from({ length: 20 }, (_, i) => msg(1 + (i % 4), `Your HYPE reward is ready 🎁 ${i}`));
  const hidden = Object.fromEntries(drops.map((m) => [m.messageId, 'Claim https://hyperliquid-claim.xyz/r']));
  assert.equal(assess(found({ title: 'HYPE rewards hub' }), seen(drops, { hidden }), HL, OFFICIAL, T0).verdict, 'scam', 'the links behind the buttons give it away');
  assert.notEqual(assess(found({ title: 'HYPE rewards hub' }), seen(drops), HL, OFFICIAL, T0).verdict, 'scam');
});

test("the project's own channel's discussion group is official; a private group shows only its cover", () => {
  const chat = assess(found({ title: 'Hyperliquid Official Chat', username: 'hyperliquid_chat', discusses: 'hyperliquid_announcements' }), seen(lively(talk)), HL, OFFICIAL, T0);
  assert.equal(chat.verdict, 'good');
  assert.ok(chat.good.some((x) => /official: the discussion group of @hyperliquid_announcements/.test(x)));
  const linked = assess(found({ title: 'HL Daily Chat', username: 'hl_daily_chat' }), seen(lively(talk), { linked: { username: 'hl_daily', title: 'Hyperliquid Daily', type: 'channel', official: false } }), HL, OFFICIAL, T0);
  assert.ok(linked.good.some((x) => /the discussion group of @hl_daily/.test(x)));

  const cover = { hash: 'HlPrivAlpha1', chatId: -2_000_000_000_001, title: 'HL Alpha Private', about: 'Hyperliquid traders sharing notes', members: 800, type: 'group' as const, verified: false, scam: false, fake: false, requestNeeded: true, paid: false, people: 2 };
  const p = assessPrivate(cover, HL, OFFICIAL);
  assert.equal(p.verdict, 'closed');
  assert.equal(p.private, true);
  assert.equal(p.link, 'https://t.me/+HlPrivAlpha1');
  assert.ok(p.good.some((x) => /shared by 2 people in your groups/.test(x)));
  assert.match(p.bad.join(' '), /private: only members can read it, and joining needs an admin to approve/);
  const fake = assessPrivate({ ...cover, title: 'Hyperliquid Official Support' }, HL, OFFICIAL);
  assert.equal(fake.verdict, 'scam');
  assert.equal(fake.link, null, 'no way in to a likely scam');
});

// ── the search itself, against a stand-in Telegram ─────────────────────────

const channel = (id: number, title: string, username: string, over: Record<string, unknown> = {}) =>
  new Api.Channel({ id: bigInt(id), title, username, accessHash: bigInt(id * 7), megagroup: true, date: 0, photo: new Api.ChatPhotoEmpty(), participantsCount: 5000, ...over });
const asChannel = { megagroup: false, broadcast: true };

interface FakeChat {
  e: Api.Channel;
  /** The latest messages; none: only members can read it. */
  msgs?: (now: number) => Api.Message[];
  full?: { about?: string; online?: number; linked?: number };
}

/** `users` people (none: channel posts), one message every `every` seconds, newest `start` seconds ago. */
const said = (id: number, texts: string[], o: { users?: number; every?: number; start?: number; views?: number; count?: number; extra?: (i: number) => Partial<ConstructorParameters<typeof Api.Message>[0]> } = {}) => (now: number) =>
  Array.from({ length: o.count ?? 100 }, (_, i) => {
    const users = o.users ?? 0;
    return new Api.Message({
      id: 1000 - i,
      peerId: new Api.PeerChannel({ channelId: bigInt(id) }),
      date: now - (o.start ?? 0) - i * (o.every ?? 200),
      message: `${texts[i % texts.length]} · ${i}`,
      ...(users > 0 ? { fromId: new Api.PeerUser({ userId: bigInt(100 + (i % users)) }) } : { post: true }),
      ...(o.views ? { views: o.views } : {}),
      ...(o.extra?.(i) ?? {}),
    });
  });

function fakeTelegram() {
  const chats: Record<number, FakeChat> = {};
  const put = (c: FakeChat) => {
    chats[Number(String(c.e.id))] = c;
    return c.e;
  };
  const meetupLink = (i: number) => (i < 3 ? { message: `周末 hyperliquid 线下见面会 t.me/hl_meetups · ${i}` } : {});
  const CN = put({ e: channel(11, 'Hyperliquid 中文社区', 'hl_cn_community'), msgs: said(11, talk, { users: 30 }), full: { online: 400 } });
  const SUPPORT = put({ e: channel(12, 'Hyperliquid Official Support', 'hl_support_desk', { hasLink: true }), full: { linked: 26 } });
  put({ e: channel(26, 'HL Desk', 'hl_desk', asChannel) });
  const VIP = put({ e: channel(13, 'Hyperliquid VIP Signals', 'hl_vip', asChannel), msgs: said(13, ['VIP signals: 100x gems, DM me to join']) });
  const DEAD = put({ e: channel(14, 'Hyperliquid Whales', 'hl_whales', { participantsCount: 20000 }), msgs: said(14, ['gm', 'hyperliquid pump soon'], { users: 3, start: 30 * DAY, every: 1 }) });
  const PRIVATE = put({ e: channel(15, 'HL Traders Private', 'hl_private', { joinRequest: true }) });
  const FLAGGED = put({ e: channel(16, 'Hyperliquid Rewards', 'hl_rewards', { scam: true }) });
  const OURS = put({ e: channel(17, 'Hyperliquid Announcements', 'hyperliquid_announcements', { ...asChannel, hasLink: true }), full: { linked: 24 } });
  const NEWS = put({ e: channel(18, 'Perp DEX News', 'perp_dex_news', { ...asChannel, participantsCount: 40000 }), msgs: said(18, ['Hyperliquid perp volume hits a record', 'New perp DEX listings this week on hyperliquid'], { every: 4 * 3600, views: 8000 }) });
  const DAILY = put({ e: channel(19, 'Hyperliquid Daily', 'hl_daily', { ...asChannel, hasLink: true }), msgs: said(19, ['Hyperliquid daily: HLP, funding and volume'], { every: 6 * 3600, views: 3000 }), full: { linked: 20, about: 'Daily Hyperliquid notes. Partner chat: @hl_partner_hub · ads @hl_ads_desk' } });
  put({ e: channel(20, 'HL Daily Chat', 'hl_daily_chat', { hasLink: true }), msgs: said(20, talk, { users: 25, extra: meetupLink }), full: { linked: 19, online: 300 } });
  put({ e: channel(21, 'Perp Partner Hub', 'hl_partner_hub', { participantsCount: 3000 }), msgs: said(21, talk, { users: 12 }), full: { online: 1 } });
  const PORTAL = put({
    e: channel(22, 'HYPE Portal', 'hype_portal'),
    msgs: said(22, ['Verify you are human to enter the HYPE chat', 'gm', 'gm gm'], {
      users: 2,
      count: 3,
      extra: (i) => (i === 0 ? { replyMarkup: new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonUrl({ text: 'Tap to verify', url: 'https://t.me/hype_safeguard_bot?start=join' })] })] }) } : {}),
    }),
  });
  const OFFICIAL_CHAT = put({ e: channel(24, 'Hyperliquid Official Chat', 'hyperliquid_chat', { hasLink: true }), msgs: said(24, talk, { users: 40 }), full: { linked: 17, online: 900 } });
  put({ e: channel(27, 'Weekend meetups', 'hl_meetups'), msgs: said(27, ['hyperliquid 线下见面会，这周六在上海', '下次 meetup 讲 HLP 和 hyperevm'], { users: 15, every: 900 }) });
  const LATE = channel(28, 'Hyperliquid Builders', 'hl_builders');
  put({ e: LATE, msgs: said(28, ['hyperevm 上线了新合约', 'hyperliquid builder codes 怎么用'], { users: 20 }) });
  const search: Record<string, Api.Channel[]> = { hyperliquid: [CN, SUPPORT, VIP, DEAD, PRIVATE, FLAGGED, OURS, DAILY, PORTAL, OFFICIAL_CHAT] };

  const requests: string[] = [];
  const idOf = (x: unknown) => Number(String((x as { id: unknown }).id));
  const flood = { on: null as number | null };
  const client = {
    async invoke(req: { className: string; q?: string; hash?: string; channel?: unknown }) {
      requests.push(req.className + (req.q ? ` ${req.q}` : req.channel ? ` ${idOf(req.channel)}` : ''));
      if (req.className === 'contacts.Search') return { chats: search[req.q!] ?? [] };
      if (req.className === 'channels.GetChannelRecommendations') return { chats: [NEWS] };
      if (req.className === 'channels.GetFullChannel') {
        const c = chats[idOf(req.channel)];
        const linked = c.full?.linked ? chats[c.full.linked].e : null;
        return { fullChat: { participantsCount: c.e.participantsCount, onlineCount: c.full?.online, about: c.full?.about ?? '', linkedChatId: linked ? linked.id : undefined, botInfo: [] }, chats: linked ? [linked] : [], users: [] };
      }
      if (req.className === 'messages.CheckChatInvite') {
        if (req.hash === 'HlPrivAlpha1') return new Api.ChatInvite({ title: 'HL Alpha Private', about: 'Hyperliquid traders sharing notes', participantsCount: 800, megagroup: true, requestNeeded: true, photo: new Api.PhotoEmpty({ id: bigInt(0) }), color: 0 });
        throw Object.assign(new Error('INVITE_HASH_EXPIRED'), { errorMessage: 'INVITE_HASH_EXPIRED' });
      }
      throw new Error(`unexpected ${req.className}`);
    },
    async getEntity(ref: string) {
      requests.push(`getEntity ${ref}`);
      const c = Object.values(chats).find((x) => x.e.username!.toLowerCase() === ref.replace('@', '').toLowerCase());
      if (!c) throw Object.assign(new Error('USERNAME_NOT_OCCUPIED'), { errorMessage: 'USERNAME_NOT_OCCUPIED' });
      return c.e;
    },
    async getMessages(e: Api.Channel, params: { limit?: number }) {
      requests.push(`getMessages ${idOf(e)} ${params.limit}`);
      if (idOf(e) === flood.on) throw Object.assign(new Error('FLOOD_WAIT_120'), { errorMessage: 'FLOOD_WAIT_120', seconds: 120 });
      const c = chats[idOf(e)];
      if (!c?.msgs) throw Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' });
      return c.msgs(clockNow());
    },
  };
  let clockNow = () => T0;
  return { client: client as unknown as TelegramClient, requests, search, LATE, flood, setClock: (f: () => number) => (clockNow = f) };
}

function setup(perHour = 5) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
  store.watchChat({ chatId: -1000000000017, title: 'Hyperliquid Announcements', username: 'hyperliquid_announcements', type: 'channel', ref: '@hyperliquid_announcements' }, 42, null, defaults);
  store.watchChat({ chatId: -1000000000099, title: 'Our Group', username: 'our_group', type: 'supergroup', ref: '@our_group' }, 42, null, defaults);
  for (let i = 0; i < 3; i++) store.saveMessage({ chatId: -1000000000099, messageId: 500 + i, threadId: null, userId: 1 + i, date: T0 - 3600, text: '中文的 hyperliquid 群：t.me/hl_cn_community', replyTo: null, reactions: 0, edited: false });
  for (let i = 0; i < 2; i++) store.saveMessage({ chatId: -1000000000099, messageId: 600 + i, threadId: null, userId: 10 + i, date: T0 - 1800, text: '一个 hyperliquid 私密群 t.me/+HlPrivAlpha1', replyTo: null, reactions: 0, edited: false });
  const activity = new Activity(store);
  const tg = fakeTelegram();
  tg.setClock(clock.now);
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
    perHour,
  });
  const finish = async () => {
    for (let i = 0; i < 4000 && discovery.view().running; i++) await new Promise((r) => setTimeout(r, 2));
    return discovery.view().latest[0];
  };
  return { clock, store, tg, pages, discovery, finish };
}

test('one search (groups and channels): every way in, a look at each within the budget, scams set apart', async () => {
  const { store, tg, pages, discovery, finish } = setup(1);
  const started = discovery.start('hyperliquid', null, { actor: 'claude', via: ' · via Claude Code' }, 'both');
  assert.equal(started.ok, true);
  assert.equal(discovery.start('crypto', null, { actor: 'console', via: '' }).ok, false, 'one at a time');
  const run = await finish();
  assert.equal(run.error, null);
  assert.equal(run.kind, 'both');
  assert.deepEqual(pages, ['https://hyperliquid.xyz'], "the project's own site, for its official handles");
  const v = Object.fromEntries(run.results.map((r) => [r.username ?? r.title, r.verdict]));
  for (const [name, verdict] of Object.entries({ hl_cn_community: 'good', hyperliquid_chat: 'good', hl_daily_chat: 'good', hl_whales: 'low', hl_private: 'closed', 'HL Alpha Private': 'closed', hl_support_desk: 'scam', hl_rewards: 'scam', hl_vip: 'scam', hype_portal: 'scam' })) {
    assert.equal(v[name], verdict, name);
  }
  for (const name of ['perp_dex_news', 'hl_daily', 'hl_meetups', 'hl_partner_hub']) assert.ok(['good', 'ok'].includes(v[name]), `${name}: ${v[name]}`);
  assert.ok(!('hyperliquid_announcements' in v), 'what is already read is left out');
  assert.match(run.notes.join(' '), /1 of what was found you already read: Hyperliquid Announcements/);
  const of = (u: string) => run.results.find((r) => r.username === u)!;
  assert.ok(of('hl_cn_community').good.some((x) => /linked by 3 people in your groups/.test(x)));
  assert.ok(of('hl_cn_community').good.some((x) => /400 of 5,000 members online/.test(x)), 'the full look at the best');
  assert.ok(of('hyperliquid_chat').good.some((x) => /official: the discussion group of @hyperliquid_announcements/.test(x)), "its name claims official, and Telegram links it to the project's channel");
  assert.ok(of('hl_daily_chat').via.includes('discussion group of @hl_daily'), 'found through the channel Telegram links it to');
  assert.ok(of('hl_meetups').via.includes('linked from @hl_daily_chat'), 'three people in a group looked at linked it');
  assert.ok(of('hl_partner_hub').via.includes("linked from @hl_daily's description"));
  assert.ok(of('hl_partner_hub').bad.some((x) => /3,000 members but 1 online/.test(x)));
  assert.ok(of('perp_dex_news').good.some((x) => /a post is seen by about 8,000/.test(x)));
  assert.match(of('hype_portal').bad.join(' '), /verify you are human/);
  const alpha = run.results.find((r) => r.private)!;
  assert.equal(alpha.link, 'https://t.me/+HlPrivAlpha1');
  assert.ok(alpha.via.includes('invite link shared by 2 people in your groups'));
  assert.equal(run.results[0].verdict, 'good', 'the best first');
  assert.ok(run.results.every((r) => !r.isNew && !r.was), 'nothing to compare with yet');
  assert.equal(run.previousAt, null, 'the first such search');

  // What was asked of Telegram: reads only, within the budget, each one counted.
  assert.equal(run.requests, tg.requests.length);
  assert.ok(run.requests <= 45, `${run.requests} requests`);
  assert.ok(tg.requests.every((r) => /^(contacts\.Search|channels\.GetChannelRecommendations|channels\.GetFullChannel|messages\.CheckChatInvite|getEntity|getMessages) ?/.test(r)), 'nothing but reads');
  assert.ok(!tg.requests.some((r) => /^getMessages (12|16) /.test(r)), 'no look at what its name or Telegram already gives away');
  assert.ok(tg.requests.includes('channels.GetFullChannel 12'), 'which channel a group calling itself official support belongs to (not the project\'s)');
  assert.equal(tg.requests.filter((r) => r.startsWith('contacts.Search')).length, HL.queries.length + HL.groupQueries.length);
  assert.equal(tg.requests.filter((r) => r.startsWith('messages.CheckChatInvite')).length, 1);
  assert.deepEqual(store.activity({ actor: 'claude' }).map((r) => r.method), ['find groups', 'groups found']);
  assert.equal(discovery.start('crypto', null, { actor: 'console', via: '' }).ok, false, 'rationed');
  assert.deepEqual(discovery.dismiss(-1000000000011), { ok: true, message: 'Hidden from future searches.' });
});

test('groups only, then again: channels are only a way in, what was looked at is remembered, and what is new is marked', async () => {
  const { clock, tg, discovery, finish } = setup();
  const by = { actor: 'console', via: '' };
  assert.equal(discovery.start('hyperliquid', null, by).ok, true, 'groups by default');
  const first = await finish();
  assert.equal(first.kind, 'groups');
  assert.ok(first.results.length > 5);
  assert.ok(first.results.every((r) => r.type === 'group'), 'no channel is judged');
  assert.ok(first.results.some((r) => r.username === 'hl_daily_chat'), "a channel's discussion group still is");
  assert.match(first.notes.join(' '), /channels found were left out \(groups only\)/);
  const firstLooks = tg.requests.filter((r) => r.startsWith('getMessages')).length;
  assert.ok(firstLooks >= 6);

  tg.search.hyperliquid.push(tg.LATE);
  clock.t += 2 * 3600;
  tg.requests.length = 0;
  assert.equal(discovery.start('hyperliquid', null, by).ok, true);
  const second = await finish();
  assert.equal(second.error, null);
  assert.deepEqual(tg.requests.filter((r) => r.startsWith('getMessages')), ['getMessages 28 100'], 'only the new group is looked at again');
  assert.ok(!tg.requests.some((r) => r.startsWith('getEntity')), 'usernames looked up in the last day are not asked about again');
  assert.deepEqual(tg.requests.filter((r) => /GetFullChannel|CheckChatInvite/.test(r)), ['channels.GetFullChannel 28'], 'descriptions and the invite are remembered: only the new group gets its full look');
  assert.ok(second.remembered >= firstLooks, `${second.remembered} remembered`);
  assert.ok(second.requests <= first.requests - firstLooks, `${second.requests} requests, against ${first.requests}`);
  assert.match(second.notes.join(' '), /came from memory/);
  assert.deepEqual(second.results.filter((r) => r.isNew).map((r) => r.username), ['hl_builders'], 'only what the last search did not have');
  assert.equal(second.previousAt, first.at, 'measured against the last search of the same kind');
  assert.equal(second.results.find((r) => r.username === 'hl_cn_community')!.isNew, undefined);
});

test('when Telegram asks the account to wait, the search stops there and keeps what it judged', async () => {
  const { tg, discovery, finish } = setup();
  tg.flood.on = 14; // the fourth look
  assert.equal(discovery.start('hyperliquid', null, { actor: 'console', via: '' }).ok, true);
  const run = await finish();
  assert.match(run.error ?? '', /slow down, so the search stopped here/);
  assert.equal(tg.requests.at(-1), 'getMessages 14 100', 'nothing more after the wait was asked for');
  assert.ok(run.results.some((r) => r.username === 'hl_cn_community' && r.verdict === 'good'), 'what was judged before stays');
  assert.ok(!run.results.some((r) => r.username === 'hl_whales'), 'the one it could not look at is not called closed');
});
