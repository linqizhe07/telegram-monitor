import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFeedUrl, NewsRadar } from '../src/news.ts';
import type { Notice } from '../src/notify.ts';
import type { StoredMessage } from '../src/store.ts';
import { Clock, memoryStore, T0, testConfig } from './helpers.ts';

const GROUP = -1001111111111;
const CHANNEL = -1002222222222;
const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };

function setup(opts: { feed?: () => Response } = {}) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  store.watchChat({ chatId: GROUP, title: '币安官方中文群', username: 'cn_test', type: 'supergroup', ref: '@cn_test' }, 42, null, defaults);
  store.watchChat({ chatId: CHANNEL, title: 'Watcher Guru', username: 'WatcherGuru', type: 'channel', ref: '@WatcherGuru' }, 42, null, defaults);
  const notices: Notice[] = [];
  const events: { method: string; target: string; detail: string }[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchFake = (async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, headers: init.headers });
    return opts.feed ? opts.feed() : new Response('<rss><channel></channel></rss>', { status: 200 });
  }) as unknown as typeof fetch;
  const radar = new NewsRadar({
    store,
    config: testConfig(),
    now: clock.now,
    log: () => undefined,
    activity: { event: (_a: string, method: string, target: string, detail: string) => events.push({ method, target, detail }) } as never,
    notifier: { notify: (n) => notices.push(n) },
    fetch: fetchFake,
    live: true,
  });
  radar.syncSources();
  let next = 1;
  const say = (chatId: number, text: string, at: number, userId = 500 + next): StoredMessage => {
    const m: StoredMessage = { chatId, messageId: next++, threadId: null, userId, date: at, text, replyTo: null, reactions: 0, edited: false };
    store.upsertUser(chatId, userId, `user${userId}`, null);
    store.saveMessage(m);
    return m;
  };
  return { clock, store, radar, notices, events, requests, say };
}

const RSS = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>The Block</title>${items}</channel></rss>`;
const ITEM = (guid: string, title: string, at: number) => `<item><title><![CDATA[${title}]]></title><link>https://theblock.example/${guid}</link><guid>${guid}</guid><pubDate>${new Date(at * 1000).toUTCString()}</pubDate></item>`;

test('feeds are read conditionally: the first read is backlog, later items are breaking, an unchanged feed costs nothing', async () => {
  let body = RSS(ITEM('a', 'Winklevoss group seeks to launch Zcash ETF, proposed WINK ticker', T0 - 600));
  let status = 200;
  const env = setup({ feed: () => (status === 304 ? new Response(null, { status: 304 }) : new Response(body, { status: 200, headers: { etag: 'W/"1"', 'last-modified': 'Tue, 06 Oct 2026 01:00:00 GMT' } })) });
  const src = env.store.newsSource('theblock')!;
  assert.deepEqual(await env.radar.fetchSource(src), { added: 1, status: '1 new' });
  assert.equal(env.store.newsItems(0)[0].backlog, true, 'what a feed already had when first read is not breaking news');
  env.clock.t += 300;
  body = RSS(ITEM('a', 'Winklevoss group seeks to launch Zcash ETF, proposed WINK ticker', T0 - 600) + ITEM('b', 'Zcash rallies after the filing', T0 + 200));
  assert.equal((await env.radar.fetchSource(env.store.newsSource('theblock')!)).added, 1);
  assert.equal(env.requests[1].headers['if-none-match'], 'W/"1"', 'asks only for what changed');
  assert.equal(env.store.newsItems(0).find((i) => i.guid === 'b')!.backlog, false);
  status = 304;
  assert.deepEqual(await env.radar.fetchSource(env.store.newsSource('theblock')!), { added: 0, status: 'not modified' });
  assert.equal(env.requests.every((r) => /GroupPulse/.test(r.headers['user-agent'])), true);
});

test('a feed that fails is reported once, and again only after it has come back', async () => {
  let fail = true;
  const env = setup({ feed: () => (fail ? new Response('nope', { status: 503 }) : new Response(RSS(''), { status: 200 })) });
  await env.radar.fetchSource(env.store.newsSource('theblock')!);
  await env.radar.fetchSource(env.store.newsSource('theblock')!);
  assert.equal(env.events.filter((e) => e.method === 'feed failed').length, 1);
  assert.equal(env.store.newsSource('theblock')!.lastError, 'HTTP 503');
  fail = false;
  await env.radar.fetchSource(env.store.newsSource('theblock')!);
  assert.equal(env.store.newsSource('theblock')!.lastError, null);
  assert.ok(env.events.some((e) => e.method === 'feed back'));
});

test('a news channel post becomes the first report; the group reacting to it raises one alert, once', async () => {
  const env = setup();
  // Last week: the group talks about Bitcoin all the time, never about SpaceX.
  for (let d = 1; d <= 5; d++) for (let i = 0; i < 30; i++) env.say(GROUP, i % 2 ? '大饼要涨' : 'BTC 又跌了', T0 - d * 86_400 + i * 60, 600 + (i % 7));
  // Watcher Guru posts the news; the reader stores it.
  const post = env.say(CHANNEL, 'JUST IN: Elon Musk’s SpaceX $SPCX surges to $175, surpassing a $2.38 trillion market cap.\n\n@WatcherGuru', T0, 9);
  env.radar.onStored(CHANNEL, [post]);
  await env.radar.rebuild();
  const v0 = env.radar.view();
  assert.equal(v0.keywords[0].sources[0].name, 'Watcher Guru');
  assert.equal(v0.keywords[0].sources[0].link, `https://t.me/WatcherGuru/${post.messageId}`);
  // The group reacts: three people within a few minutes.
  env.clock.t = T0 + 780;
  const replies = [env.say(GROUP, '谁买了spacex', T0 + 600, 701), env.say(GROUP, 'spacex 还得涨', T0 + 700, 702), env.say(GROUP, '$SPCX 冲', T0 + 780, 703)];
  env.radar.onStored(GROUP, replies);
  assert.equal(env.notices.length, 1);
  assert.deepEqual(env.notices[0], { kind: 'news', group: '币安官方中文群', body: '3 messages from 3 people about SpaceX · Elon Musk, 10m after Watcher Guru reported it.' });
  assert.ok(env.events.some((e) => e.method === 'news in the group' && e.target === '币安官方中文群'));
  assert.ok(env.events.some((e) => e.method === 'in the group' && /SpaceX/.test(e.detail)), 'the first mention is logged');
  // More messages, a rebuild: the same story is not raised twice.
  env.clock.t += 120;
  env.radar.onStored(GROUP, [env.say(GROUP, 'spacex!!!', T0 + 900, 704)]);
  await env.radar.rebuild();
  assert.equal(env.notices.length, 1);
  const v = env.radar.view();
  const echo = v.keywords.find((k) => k.label.includes('SpaceX'))!.groups[0];
  assert.equal(echo.count, 4);
  assert.equal(echo.level, 'hot');
  assert.equal(echo.firstLag, 600);
  assert.deepEqual(echo.messages[0].marks, [[3, 9]], 'where "spacex" is, for highlighting');
  assert.equal(v.hits.length, 4);
  assert.ok(!v.hits.some((h) => /大饼|BTC/.test(h.text)), 'the group\'s everyday Bitcoin talk is not news');
});

test('after a restart, old matches are shown but not raised again; a lead before the first report is raised when the news breaks', async () => {
  const env = setup({ feed: () => new Response(RSS(ITEM('z', 'Winklevoss group seeks to launch Zcash ETF, proposed WINK ticker', T0)), { status: 200 }) });
  // Yesterday's story and its echo: found by the rescan, not raised.
  const old = env.say(CHANNEL, 'JUST IN: Hyperliquid lists $XYZ perpetuals', T0 - 30_000, 9);
  env.radar.onStored(CHANNEL, [old]);
  for (const [i, u] of [701, 702, 703].entries()) env.say(GROUP, 'hyperliquid xyz 上了', T0 - 29_000 + i * 60, u);
  await env.radar.rebuild();
  assert.equal(env.notices.length, 0, 'nothing live: no notification for what happened while it was off');
  // The group talks about ZEC; an hour later the first report comes in.
  for (const [i, u] of [801, 802, 803].entries()) env.say(GROUP, i === 1 ? '大零币要起飞' : 'ZEC 冲了', T0 - 3600 + i * 120, u);
  env.store.updateNewsSource('theblock', { lastOkAt: T0 - 300 }); // read before: this item is breaking
  env.clock.t = T0 + 60;
  await env.radar.fetchSource(env.store.newsSource('theblock')!);
  await env.radar.rebuild();
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0].kind, 'ahead');
  assert.match(env.notices[0].body, /^3 messages from 3 people about .*Zcash.*, 1h00m before The Block reported it\.$/);
  const zec = env.radar.view().keywords.find((k) => /Zcash/.test(k.label))!;
  assert.equal(zec.groups[0].level, 'first');
  assert.equal(zec.groups[0].firstLag, -3600);
  // Hours later, the group's own talk before the news has not become its baseline: still a lead.
  env.clock.t = T0 + 10 * 3600;
  await env.radar.rebuild();
  const later = env.radar.view().keywords.find((k) => /Zcash/.test(k.label))!;
  assert.equal(later.groups[0]?.level, 'first');
  assert.equal(later.groups[0].count, 3);
});

test('the owner adds feeds by link: public http(s) only, and only if it reads as a feed', async () => {
  assert.equal(checkFeedUrl('https://www.ft.com/rss/home'), 'https://www.ft.com/rss/home');
  for (const bad of ['http://localhost:4830/api/state', 'http://127.0.0.1/feed', 'https://192.168.1.4/rss', 'file:///etc/passwd', 'https://user:pw@example.com/feed', 'http://router/feed', 'not a link']) {
    assert.ok(typeof checkFeedUrl(bad) === 'object', bad);
  }
  let reply = new Response('<html>no feed here</html>', { status: 200 });
  const env = setup({ feed: () => reply });
  const no = await env.radar.addFeed('https://example.com/page', '');
  assert.equal(no.ok, false);
  assert.match(no.message, /not an RSS or Atom feed/);
  assert.equal(env.store.newsSources().filter((s) => s.url === 'https://example.com/page').length, 0, 'a failed feed is not kept');
  reply = new Response(RSS(ITEM('q', 'Quantum Ventures backs Kestrel Labs', T0 - 60)), { status: 200 });
  const yes = await env.radar.addFeed('https://example.com/feed', 'Example');
  assert.equal(yes.ok, true);
  const added = env.store.newsSources().find((s) => s.name === 'Example')!;
  assert.equal(env.radar.remove(added.id).ok, true);
  assert.equal(env.radar.remove('bloomberg-markets').ok, false, 'a builtin source is switched off, not removed');
  assert.equal(env.radar.setEnabled('bloomberg-markets', false).ok, true);
  assert.equal(env.store.newsSource('bloomberg-markets')!.enabled, false);
});
