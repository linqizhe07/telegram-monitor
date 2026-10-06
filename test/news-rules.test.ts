import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attention,
  buildLexicon,
  buildTopics,
  cleanHeadline,
  extractTerms,
  formatLag,
  keysIn,
  matchSpans,
  parseFeed,
  postAsNews,
  rarityFactor,
  scoreTopic,
  shownHits,
  type Hit,
  type NewsItem,
} from '../src/news-rules.ts';

const T = Date.UTC(2026, 9, 6, 12, 0) / 1000;
const keys = (title: string, summary = '') => Object.fromEntries(extractTerms(title, summary).map((t) => [t.key, t.cls]));

test('feeds: RSS with CDATA and double-encoded entities, Atom links, and no summary for Hacker News', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Bloomberg Crypto</title>
    <item><title><![CDATA[Crypto Exchange OKX Raises at $25 Billion From StanChart, Circle]]></title>
      <description><![CDATA[Fresh capital from Qube Research &amp; Technologies.]]></description>
      <link>https://www.bloomberg.com/news/articles/2026-10-06/okx</link><guid isPermaLink="false">TMG59</guid>
      <pubDate>Tue, 06 Oct 2026 12:00:00 GMT</pubDate></item>
    <item><title>Show HN: A tiny database</title><link>https://example.com/db</link>
      <description>&lt;a href="https://news.ycombinator.com/item?id=1"&gt;Comments&lt;/a&gt;</description></item>
    <item><title></title><link>https://example.com/empty</link></item>
  </channel></rss>`;
  const f = parseFeed(rss);
  assert.equal(f.title, 'Bloomberg Crypto');
  assert.equal(f.entries.length, 2, 'an item without a title is skipped');
  assert.deepEqual(f.entries[0], {
    guid: 'TMG59',
    title: 'Crypto Exchange OKX Raises at $25 Billion From StanChart, Circle',
    link: 'https://www.bloomberg.com/news/articles/2026-10-06/okx',
    summary: 'Fresh capital from Qube Research & Technologies.',
    publishedAt: Date.UTC(2026, 9, 6, 12, 0) / 1000,
  });
  assert.equal(f.entries[1].summary, '', 'Hacker News: "Comments" is a link, not a summary');
  assert.equal(f.entries[1].publishedAt, null);

  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>a16z</title><entry><title type="html">Investing &amp;amp; Medicine</title>
    <link rel="self" href="https://a16z.example/self"/><link rel="alternate" href="https://a16z.example/post"/><id>urn:1</id><updated>2026-10-06T15:30:49Z</updated>
    <summary>On &lt;b&gt;medicine&lt;/b&gt;.</summary></entry></feed>`;
  const a = parseFeed(atom).entries[0];
  assert.equal(a.title, 'Investing & Medicine');
  assert.equal(a.link, 'https://a16z.example/post');
  assert.equal(a.guid, 'urn:1');
  assert.equal(a.summary, 'On medicine .');
  assert.equal(a.publishedAt, Date.UTC(2026, 9, 6, 15, 30, 49) / 1000);
  assert.deepEqual(parseFeed('<html><body>not a feed</body></html>').entries, []);
});

test('headlines: wire tags, handles, links and trailers come off; ads and bare photos are not news', () => {
  assert.equal(cleanHeadline('JUST IN: 🇺🇸 US trade deficit surges 13.7%\n\n@WatcherGuru'), 'US trade deficit surges 13.7%');
  assert.deepEqual(postAsNews('[photo] 🇺🇸 NEW: Winklevoss Zcash ETF files an S-1 with the SEC.\n\nNews | Markets | YouTube'), { title: 'Winklevoss Zcash ETF files an S-1 with the SEC.', summary: '' });
  assert.equal(postAsNews('🔴 [LIVE] OKX Now kicks off from Singapore! [Brought to you by OKX]'), null, 'sponsored');
  assert.equal(postAsNews('[photo]'), null);
  assert.equal(cleanHeadline('Show HN: A tiny database'), 'A tiny database');
});

test('terms: tickers, names and aliases are strong; broad topics and the majors are medium', () => {
  const block = keys('Winklevoss group seeks to launch Zcash ETF with 0.25% fee, proposed WINK ticker');
  assert.equal(block['p:winklevoss'], 'strong');
  assert.equal(block.zec, 'strong', 'Zcash is the ZEC concept');
  assert.equal(block.wink, 'strong', 'an all-caps ticker');
  assert.equal(block.etf, 'medium');
  const okx = keys('Crypto Exchange OKX Raises at $25 Billion From StanChart, Circle');
  assert.deepEqual([okx.okx, okx.stanchart, okx.circle], ['strong', 'strong', 'strong']);
  assert.equal(keys('JUST IN: Elon Musk’s SpaceX $SPCX surges to $175')['spacex'], 'strong', '$SPCX is SpaceX');
  assert.equal(keys('Bitcoin hits a new high').btc, 'medium', 'Bitcoin alone does not say which story');
  const fund = keys('Peter Thiel-backed Founders Fund leads a $5 million token buy in crypto collateral protocol Anvil');
  assert.equal(fund['founders fund'], 'strong', 'a name with an organization suffix');
  assert.equal(fund.anvil, 'medium');
  assert.equal(fund.peter, undefined, 'a first name alone is not a name');
});

test('terms: in a Title Case headline a capitalized word is a name only if the summary capitalizes it too', () => {
  const k = keys(
    'Bitcoin Bulls Descend on Singapore in Search of the Next Bet',
    'Crypto executives are gathering in Singapore after a Bitcoin-led rally revived a market that had been struggling.',
  );
  assert.ok(!['strong', 'medium'].includes(k.descend), '"Descend" is a Title Case word');
  assert.ok(!['strong', 'medium'].includes(k.search));
  assert.equal(k.btc, 'medium');
});

test('terms: Chinese headlines keep their Latin names and map Chinese aliases to the same concepts', () => {
  const k = keys('Winklevoss时隔13年申请Zcash ETF，曾放弃首份现货比特币ETF申请');
  assert.equal(k['p:winklevoss'], 'strong');
  assert.equal(k.zec, 'strong');
  assert.equal(k.btc, 'medium', '比特币 is Bitcoin');
  assert.equal(k['比特币'], undefined, 'not also a Chinese word of its own');
});

test('messages: aliases the groups use, whole words only, and ambiguous tickers only as tickers', () => {
  const items = [{ id: 1, sourceId: 'x', sourceName: 'X', tier: 1, title: 'Winklevoss Zcash ETF filing; SpaceX $SPCX surges; NEAR rallies', summary: '', link: null, publishedAt: T, seenAt: T, backlog: false }];
  const lex = buildLexicon(buildTopics(items, { now: T }).flatMap((t) => t.terms));
  assert.deepEqual([...keysIn('谁买了spacex', lex)], ['spacex']);
  assert.ok(keysIn('大零币今天能不能吃肉就看你了', lex).has('zec'));
  assert.ok(keysIn('Zec又要起飞了', lex).has('zec'));
  assert.ok(keysIn('感觉大饼二饼要瀑布了', lex).has('btc'));
  assert.ok(keysIn('鲍威尔今晚讲话', lex).has('p:powell'));
  assert.ok(!keysIn('The group opérate in Binance futures?', lex).has('op'), 'an accented word is one word');
  assert.ok(!keysIn('用op麻烦', lex).has('op'), '"op" in lowercase is not Optimism');
  assert.ok(keysIn('OP is pumping', lex).has('op'));
  assert.ok(!keysIn('we are near the top', lex).has('near'));
  assert.ok(keysIn('$near looks strong', lex).has('near'), 'a cashtag in any case');
  assert.ok(!keysIn('method and together', lex).has('eth'), 'whole words: no ETH inside "method"');
  assert.deepEqual(matchSpans('谁买了spacex 和 ZEC?', lex, new Set(['spacex', 'zec'])), [[3, 9], [12, 15]]);
});

const item = (id: number, sourceId: string, title: string, at: number, tier = 1): NewsItem => ({ id, sourceId, sourceName: sourceId, tier, title, summary: '', link: `https://${sourceId}.example/${id}`, publishedAt: at, seenAt: at, backlog: false });

test('topics: the same story from three outlets is one keyword; unrelated stories sharing only "Bitcoin" are not', () => {
  const topics = buildTopics(
    [
      item(1, 'theblock', 'Winklevoss group seeks to launch Zcash ETF with 0.25% fee, proposed WINK ticker', T),
      item(2, 'cointelegraph', 'Winklevoss Zcash ETF files an S-1 registration statement with the SEC.', T + 700, 2),
      item(3, 'odaily', 'Winklevoss时隔13年申请Zcash ETF，曾放弃首份现货比特币ETF申请', T + 1800),
      item(4, 'bloomberg', 'Bitcoin Rises as Traders Weigh Fed Path', T + 100),
      item(5, 'coindesk', 'Bitcoin miners sell more coins as hashprice falls', T + 200),
      item(6, 'nyt', 'A Quiet Day in Albany', T + 300),
    ],
    { now: T + 3600 },
  );
  const zcash = topics.find((t) => t.terms.some((x) => x.key === 'zec'))!;
  assert.deepEqual(zcash.items.map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(zcash.sources.map((s) => s.id), ['theblock', 'cointelegraph', 'odaily']);
  assert.equal(zcash.firstAt, T, 'the first report is the earliest item');
  assert.equal(topics[0], zcash, 'three outlets rank first');
  assert.match(zcash.label, /Winklevoss/);
  const btc = topics.filter((t) => t.items.some((i) => i.id === 4 || i.id === 5));
  assert.equal(btc.length, 2, 'Bitcoin alone does not make two stories one');
  assert.ok(!topics.some((t) => t.items.some((i) => i.id === 6)), 'nothing nameable: no keyword');
});

test('rarity: what a group says all the time counts for nothing; what it rarely says counts in full', () => {
  assert.equal(rarityFactor({ count: 0, total: 9000, days: 1.5 }), 1);
  assert.equal(rarityFactor({ count: 2, total: 50, days: 1 }), 1, 'too few to judge');
  assert.equal(rarityFactor({ count: 65, total: 9170, days: 1.3 }), 0, '大饼 in a Binance group');
  assert.equal(rarityFactor({ count: 8, total: 2000, days: 1.5 }), 0.5);
  assert.equal(rarityFactor({ count: 5, total: 9170, days: 1.3 }), 1);
});

test('scoring: one rare strong name is enough; one medium term is not; two are', () => {
  const [topic] = buildTopics([item(1, 'theblock', 'Winklevoss group seeks to launch Zcash ETF, proposed WINK ticker', T)], { now: T });
  const rare = () => 1;
  assert.equal(scoreTopic(topic, new Set(['zec']), rare).score, 2);
  assert.equal(scoreTopic(topic, new Set(['etf']), rare).score, 1);
  assert.equal(scoreTopic(topic, new Set(['zec']), (k) => (k === 'zec' ? 0 : 1)).score, 0, 'the group talks about ZEC all the time');
  assert.equal(scoreTopic(topic, new Set(['zec', 'etf']), (k) => (k === 'zec' ? 0.5 : 1)).score, 2);
});

const hit = (messageId: number, userId: number, lag: number): Hit => ({ chatId: -100, messageId, userId, date: T + lag, topicId: 1, terms: ['Zcash'], keys: ['zec'], score: 2, lag });

test('attention: hot after the news, first before it, and only a real cluster counts', () => {
  assert.equal(attention([]), null);
  assert.equal(attention([hit(1, 1, 120)])!.level, 'echo');
  const hot = attention([hit(1, 1, 60), hit(2, 2, 300), hit(3, 1, 900), hit(4, 3, 7200), hit(5, 2, 7300), hit(6, 4, 7400)])!;
  assert.equal(hot.level, 'hot');
  assert.deepEqual(hot.burst.map((h) => h.messageId), [4, 5, 6], 'the latest burst');
  assert.equal(attention([hit(1, 1, 60), hit(2, 1, 120), hit(3, 1, 180)])!.level, 'echo', 'one person three times is not a burst');
  assert.equal(attention([hit(1, 1, -5000), hit(2, 2, -4900), hit(3, 3, -4800)])!.level, 'first');
  assert.equal(attention([hit(1, 1, -20000), hit(2, 2, -12000), hit(3, 3, -3000)])!.level, 'echo', 'mentions spread over the morning are not a lead');
  assert.deepEqual(shownHits([hit(1, 1, -18000), hit(2, 1, -17000), hit(3, 2, 600)]).map((h) => h.messageId), [3], 'stray mentions before the news are not shown as a lead');
  assert.equal(shownHits([hit(1, 1, -5000), hit(2, 2, -4900), hit(3, 3, -4800), hit(4, 4, -100)]).length, 4, 'a lead is shown whole');
  assert.equal(formatLag(780), '+13m');
  assert.equal(formatLag(-21540), '5h59m before');
  assert.equal(formatLag(7500), '+2h05m');
});
