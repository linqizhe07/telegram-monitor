// The news radar, running: reads first-tier sources (RSS/Atom feeds, and the news channels among
// the Telegram sources), turns the day's news into keywords (news-rules.ts), and matches every
// group message against them as it is stored. A group reacting to the news, or talking about it
// before the first report, is flagged in the console and, at most once per topic, on screen.
//
// Feeds are plain HTTPS GETs of public pages, conditional (ETag / Last-Modified), one at a time,
// never with anything from the groups in them. The Telegram channels need no extra request: the
// reader stores their posts like any source's.

import type { Activity } from './activity.ts';
import type { Config } from './config.ts';
import {
  AHEAD_S,
  attention,
  buildLexicon,
  buildTopics,
  formatLag,
  HIT_SCORE,
  keysIn,
  LATE_HIT_SCORE,
  matchSpans,
  LATE_S,
  parseFeed,
  postAsNews,
  rarityFactor,
  scoreTopic,
  shownHits,
  type Hit,
  type Lexicon,
  type NewsItem,
  type Topic,
} from './news-rules.ts';
import { CONCEPTS } from './news-words.ts';
import { clean, type Notifier } from './notify.ts';
import type { ChatRow, NewsSourceRow, StoredMessage, Store } from './store.ts';

export interface FeedDef {
  id: string;
  name: string;
  url: string;
  tier: number;
  /** Seconds between two fetches. */
  everyS: number;
}

/**
 * The feeds the radar starts with (each checked by hand on 2026-10-06): first-tier outlets and
 * communities, and the crypto wires the groups react to first. Fewer, better sources: every one
 * must be worth reading on its own.
 */
export const DEFAULT_FEEDS: FeedDef[] = [
  { id: 'bloomberg-markets', name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', tier: 1, everyS: 120 },
  { id: 'bloomberg-crypto', name: 'Bloomberg Crypto', url: 'https://feeds.bloomberg.com/crypto/news.rss', tier: 1, everyS: 120 },
  { id: 'bloomberg-technology', name: 'Bloomberg Technology', url: 'https://feeds.bloomberg.com/technology/news.rss', tier: 1, everyS: 180 },
  { id: 'bloomberg-economics', name: 'Bloomberg Economics', url: 'https://feeds.bloomberg.com/economics/news.rss', tier: 1, everyS: 180 },
  { id: 'bloomberg-politics', name: 'Bloomberg Politics', url: 'https://feeds.bloomberg.com/politics/news.rss', tier: 1, everyS: 300 },
  { id: 'nyt-home', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', tier: 1, everyS: 180 },
  { id: 'nyt-business', name: 'NYT Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', tier: 1, everyS: 180 },
  { id: 'nyt-technology', name: 'NYT Technology', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', tier: 1, everyS: 300 },
  { id: 'a16z', name: 'a16z', url: 'https://www.a16z.news/feed', tier: 1, everyS: 1800 },
  { id: 'a16z-crypto', name: 'a16z crypto', url: 'https://a16zcrypto.com/feed.xml', tier: 1, everyS: 1800 },
  { id: 'hacker-news', name: 'Hacker News (YC)', url: 'https://news.ycombinator.com/rss', tier: 1, everyS: 300 },
  { id: 'yc-blog', name: 'Y Combinator', url: 'https://www.ycombinator.com/blog/rss/', tier: 1, everyS: 3600 },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', tier: 1, everyS: 120 },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss', tier: 1, everyS: 120 },
  { id: 'odaily', name: 'Odaily 快讯', url: 'https://rss.odaily.news/rss/newsflash', tier: 1, everyS: 60 },
];

/** Telegram channels known to be first-line (fast wires, official announcements): tier 1. Others are tier 2. */
const FIRST_LINE_CHANNELS = new Set(['watcherguru', 'infinityhedge', 'binance_announcements', 'hyperliquid_announcements', 'wublockchainenglish', 'wublockchain12', 'tree_news_feed', 'thedefiant']);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) GroupPulse/0.2 (news radar)';
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const WINDOW_S = 30 * 3600; // items and messages looked at: the last day, plus the 6 hours before it
const LIVE_S = 15 * 60; // a hit this recent can raise an alert; older ones were found by a rescan
const MAX_NOTIFY_PER_HOUR = 6;

export function isNewsChannel(c: ChatRow): boolean {
  return c.kind === 'watched' && c.type === 'channel';
}

export interface NewsDeps {
  store: Store;
  config: Config;
  now: () => number;
  log: (line: string) => void;
  activity?: Activity | null;
  notifier?: Notifier | null;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  /** The service: fetches feeds and raises alerts. The MCP process reads only (false). */
  live?: boolean;
}

export interface GroupEcho {
  chatId: number;
  title: string;
  count: number;
  people: number;
  /** Seconds from the first report to the group's first mention (negative: the group was first). */
  firstLag: number;
  level: 'hot' | 'first' | 'echo';
  messages: { messageId: number; date: number; author: string; text: string; terms: string[]; lag: number; marks: [number, number][] }[];
}

export interface TopicView {
  id: number;
  label: string;
  score: number;
  firstAt: number;
  lastAt: number;
  headline: string;
  link: string | null;
  items: number;
  terms: string[];
  sources: { name: string; tier: number; at: number; link: string | null; title: string }[];
  groups: GroupEcho[];
}

export interface SourceView {
  id: string;
  kind: 'rss' | 'telegram';
  name: string;
  url: string | null;
  tier: number;
  everyS: number;
  enabled: boolean;
  builtin: boolean;
  lastFetchAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  items24h: number;
  /** Median minutes from publication to the radar seeing it (recent items). */
  delayMin: number | null;
}

export interface RadarView {
  at: number;
  live: boolean;
  enabled: boolean;
  sources: SourceView[];
  items24h: number;
  keywords: TopicView[];
  /** Recent group messages that named the news, newest first. */
  hits: { chatId: number; group: string; topicId: number; label: string; messageId: number; date: number; author: string; text: string; terms: string[]; lag: number; source: string; marks: [number, number][] }[];
  alerts: { chatId: number; group: string; topicId: number; kind: string; at: number; detail: string }[];
}

export class NewsRadar {
  private readonly d: NewsDeps;
  private topics: Topic[] = [];
  private byId = new Map<number, Topic>();
  private byKey = new Map<string, Topic[]>();
  private lex: Lexicon = buildLexicon([]);
  /** Hits per group, rebuilt by every rescan and added to as messages arrive. */
  private hits = new Map<number, Hit[]>();
  private readonly baselines = new Map<string, { at: number; factor: number }>();
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private notified: number[] = [];
  private readonly errorShownAt = new Map<string, number>();
  private fetching: Promise<void> | null = null;

  constructor(deps: NewsDeps) {
    this.d = deps;
  }

  private get enabled(): boolean {
    return this.d.config.news;
  }

  // ── sources ────────────────────────────────────────────────────────────

  /** Builtin feeds and the news channels among the Telegram sources, as rows. */
  syncSources(): void {
    const { store } = this.d;
    for (const f of DEFAULT_FEEDS) store.ensureNewsSource({ ...f, kind: 'rss', builtin: true });
    for (const c of store.listChats(false).filter(isNewsChannel)) {
      const id = `tg:${c.chatId}`;
      const known = store.newsSource(id);
      const tier = c.username && FIRST_LINE_CHANNELS.has(c.username.toLowerCase()) ? 1 : 2;
      if (!known) store.ensureNewsSource({ id, kind: 'telegram', name: c.title, url: c.username ? `https://t.me/${c.username}` : null, tier, everyS: 0 });
      else if (known.name !== c.title) store.updateNewsSource(id, { name: c.title });
    }
  }

  /** Posts of the news channels from the last day, as items (the reader stored them as messages). */
  private backfillChannels(): void {
    const { store, now } = this.d;
    const t = now();
    for (const c of store.listChats(true).filter(isNewsChannel)) {
      for (const m of store.messages(c.chatId, t - WINDOW_S, t + 1)) this.ingestPost(c, m, true);
    }
  }

  private ingestPost(c: ChatRow, m: StoredMessage, backfill: boolean): boolean {
    const post = postAsNews(m.text);
    if (!post) return false;
    const t = this.d.now();
    const row = this.d.store.addNewsItem({
      sourceId: `tg:${c.chatId}`,
      guid: String(m.messageId),
      title: post.title,
      summary: post.summary,
      link: c.username ? `https://t.me/${c.username}/${m.messageId}` : null,
      publishedAt: m.date,
      seenAt: Math.max(m.date, backfill ? m.date : t),
      backlog: backfill || t - m.date > LIVE_S,
    });
    return row !== null;
  }

  // ── fetching ───────────────────────────────────────────────────────────

  /** One fetch of one feed: conditional, size-capped, timed out. */
  async fetchSource(src: NewsSourceRow): Promise<{ added: number; status: string }> {
    const { store, now } = this.d;
    const t = now();
    store.updateNewsSource(src.id, { lastFetchAt: t });
    const headers: Record<string, string> = { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' };
    if (src.etag) headers['if-none-match'] = src.etag;
    if (src.lastModified) headers['if-modified-since'] = src.lastModified;
    try {
      const res = await (this.d.fetch ?? fetch)(src.url!, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (res.status === 304) {
        store.updateNewsSource(src.id, { lastOkAt: t, lastError: null });
        this.recovered(src);
        return { added: 0, status: 'not modified' };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const size = Number(res.headers.get('content-length') ?? 0);
      if (size > MAX_FEED_BYTES) throw new Error(`feed too large (${Math.round(size / 1_048_576)} MB)`);
      const body = await res.text();
      if (body.length > MAX_FEED_BYTES) throw new Error('feed too large');
      const feed = parseFeed(body);
      if (feed.entries.length === 0 && !/<(rss|feed|rdf)\b/i.test(body)) throw new Error('not an RSS or Atom feed');
      const first = src.lastOkAt === null;
      let added = 0;
      for (const e of feed.entries) {
        let published = e.publishedAt ?? t;
        if (published > t + 600) published = t; // a date in the future: when it was seen
        if (published < t - WINDOW_S) continue;
        const row = store.addNewsItem({ sourceId: src.id, guid: e.guid, title: e.title, summary: e.summary, link: e.link, publishedAt: published, seenAt: t, backlog: first || t - published > 2 * 3600 });
        if (row) added++;
      }
      store.updateNewsSource(src.id, { lastOkAt: t, lastError: null, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), itemsTotal: src.itemsTotal + added });
      this.recovered(src);
      if (added > 0) this.scheduleRebuild();
      return { added, status: `${added} new` };
    } catch (err) {
      const msg = (err as Error).name === 'TimeoutError' ? 'no answer in 20s' : (err as Error).message.slice(0, 200);
      store.updateNewsSource(src.id, { lastError: msg });
      const last = this.errorShownAt.get(src.id) ?? 0;
      if (t - last > 3 * 3600) {
        this.errorShownAt.set(src.id, t);
        this.d.activity?.event('news', 'feed failed', src.name, `${msg}; retrying on schedule`, false);
      }
      return { added: 0, status: msg };
    }
  }

  private recovered(src: NewsSourceRow): void {
    if (!src.lastError) return;
    this.errorShownAt.delete(src.id);
    this.d.activity?.event('news', 'feed back', src.name, 'answering again');
  }

  /** Fetches every feed that is due, one at a time. */
  async fetchDue(force = false): Promise<void> {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const t = this.d.now();
      for (const src of this.d.store.newsSources()) {
        if (this.stopped) break;
        if (src.kind !== 'rss' || !src.enabled || !src.url) continue;
        const due = force || src.lastFetchAt === null || t - src.lastFetchAt >= src.everyS * (0.9 + ((src.id.length * 7) % 20) / 100);
        if (due) await this.fetchSource(src);
      }
    })().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  /** Feeds on their schedules, and a rescan every minute (lags and attention move with time). */
  start(): () => void {
    if (!this.enabled) return () => undefined;
    this.syncSources();
    this.backfillChannels();
    void this.rebuild();
    const tick = setInterval(() => void this.fetchDue().catch((err) => this.d.log(`news: ${(err as Error).message}`)), 5_000);
    const rescan = setInterval(() => {
      this.syncSources();
      void this.rebuild();
    }, 60_000);
    tick.unref?.();
    rescan.unref?.();
    void this.fetchDue();
    return () => {
      this.stopped = true;
      clearInterval(tick);
      clearInterval(rescan);
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    };
  }

  // ── topics and matching ────────────────────────────────────────────────

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild();
    }, 1500);
    this.rebuildTimer.unref?.();
  }

  /** The window's items, from enabled sources, with their source's name and tier. */
  items(): NewsItem[] {
    const { store, now } = this.d;
    const sources = new Map(store.newsSources().map((s) => [s.id, s]));
    return store
      .newsItems(now() - WINDOW_S)
      .filter((i) => sources.get(i.sourceId)?.enabled)
      .map((i) => {
        const s = sources.get(i.sourceId)!;
        return { ...i, sourceName: s.name, tier: s.tier };
      });
  }

  /** Re-reads the items, rebuilds the topics and rescans the groups' last day against them. */
  async rebuild(): Promise<void> {
    const t = this.d.now();
    this.topics = buildTopics(this.items(), { now: t });
    this.byId = new Map(this.topics.map((x) => [x.id, x]));
    this.byKey = new Map();
    for (const topic of this.topics) for (const term of topic.terms) this.byKey.set(term.key, [...(this.byKey.get(term.key) ?? []), topic]);
    this.lex = buildLexicon(this.topics.flatMap((x) => x.terms));
    const fresh = new Map<number, Hit[]>();
    let n = 0;
    for (const chat of this.groups()) {
      const hits: Hit[] = [];
      for (const m of this.d.store.messages(chat.chatId, t - WINDOW_S, t + 1)) {
        hits.push(...this.match(chat.chatId, m));
        if (++n % 1500 === 0) await new Promise((r) => setImmediate(r)); // let Telegram updates and the console through
      }
      fresh.set(chat.chatId, hits);
    }
    this.hits = fresh;
    if (this.d.live) for (const chat of this.groups()) this.evaluate(chat);
  }

  /** The groups whose messages are matched: every enabled source that is not a news channel. */
  private groups(): ChatRow[] {
    return this.d.store.listChats(true).filter((c) => (c.kind === 'watched' || c.kind === 'group') && !isNewsChannel(c));
  }

  private match(chatId: number, m: StoredMessage): Hit[] {
    const keys = keysIn(m.text, this.lex);
    if (keys.size === 0) return [];
    const candidates = new Set<Topic>();
    for (const k of keys) for (const topic of this.byKey.get(k) ?? []) candidates.add(topic);
    // One message counts for one topic: the one it names best (then the one it follows most closely).
    let best: Hit | null = null;
    for (const topic of candidates) {
      if (m.date < topic.firstAt - AHEAD_S || m.date > topic.lastAt + 12 * 3600) continue;
      const { score, matched } = scoreTopic(topic, keys, (k) => this.factor(chatId, k, topic.firstAt - AHEAD_S));
      if (score < (m.date - topic.firstAt > LATE_S ? LATE_HIT_SCORE : HIT_SCORE)) continue;
      const hit: Hit = { chatId, messageId: m.messageId, userId: m.userId, date: m.date, topicId: topic.id, terms: matched.map((x) => x.label), keys: matched.map((x) => x.key), score, lag: m.date - topic.firstAt };
      const closer = (a: Hit, b: Hit) => (a.lag >= 0 ? a.lag : AHEAD_S * 4 - a.lag) < (b.lag >= 0 ? b.lag : AHEAD_S * 4 - b.lag);
      if (!best || hit.score > best.score || (hit.score === best.score && closer(hit, best))) best = hit;
    }
    return best ? [best] : [];
  }

  /**
   * How unusual a term is for a group, from the week before `until` (the start of the topic's
   * lookback): what the group said around the news never becomes its own baseline, however much
   * later this is computed. Cached per hour of `until`.
   */
  private factor(chatId: number, key: string, until: number): number {
    const to = Math.floor(until / 3600) * 3600;
    const id = `${chatId}|${key}|${to}`;
    const t = this.d.now();
    const hit = this.baselines.get(id);
    if (hit && t - hit.at < 6 * 3600) return hit.factor;
    if (this.baselines.size > 20_000) this.baselines.clear();
    const from = to - 7 * 86_400;
    const span = this.d.store.messageSpan(chatId, from, to);
    let factor = 1;
    if (span.count > 0 && span.oldest !== null) {
      const forms = formsOf(key);
      const count = this.d.store.messagesLike(chatId, from, to, forms).filter((r) => keysIn(r.text, this.lex).has(key)).length;
      factor = rarityFactor({ count, total: span.count, days: (to - span.oldest) / 86_400 });
    }
    this.baselines.set(id, { at: t, factor });
    return factor;
  }

  /** The reader stored these messages: news channel posts become items, group messages are matched. */
  onStored(chatId: number, msgs: StoredMessage[]): void {
    if (!this.enabled || msgs.length === 0) return;
    const chat = this.d.store.getChat(chatId);
    if (!chat) return;
    if (isNewsChannel(chat)) {
      if (!this.d.store.newsSource(`tg:${chatId}`)) this.syncSources();
      let added = 0;
      for (const m of msgs) if (this.ingestPost(chat, m, false)) added++;
      if (added > 0) this.scheduleRebuild();
      return;
    }
    if (!(chat.kind === 'watched' || chat.kind === 'group')) return;
    const list = this.hits.get(chatId) ?? [];
    const have = new Set(list.map((h) => `${h.messageId}:${h.topicId}`));
    let added = 0;
    for (const m of msgs) {
      for (const h of this.match(chatId, m)) {
        if (have.has(`${h.messageId}:${h.topicId}`)) continue;
        list.push(h);
        added++;
      }
    }
    this.hits.set(chatId, list);
    if (added > 0 && this.d.live) this.evaluate(chat);
  }

  // ── attention ──────────────────────────────────────────────────────────

  /** Raises what is due for one group: the first live mention (activity), a burst or a lead (notification). */
  private evaluate(chat: ChatRow): void {
    const { store, now, activity } = this.d;
    const t = now();
    const byTopic = new Map<number, Hit[]>();
    for (const h of this.hits.get(chat.chatId) ?? []) byTopic.set(h.topicId, [...(byTopic.get(h.topicId) ?? []), h]);
    for (const [topicId, hits] of byTopic) {
      const topic = this.byId.get(topicId);
      if (!topic || topic.firstAt < t - 86_400) continue;
      const a = attention(hits);
      if (!a) continue;
      const first = topic.sources[0];
      const users = store.users(chat.chatId);
      const people = new Set(a.burst.map((h) => h.userId)).size;
      if (a.level === 'hot' && a.burst[a.burst.length - 1].date >= t - LIVE_S) {
        const lag = a.burst[0].lag;
        const detail = `${a.burst.length} messages from ${people} people about ${topic.label}, ${lag < 60 ? 'right after' : `${formatLag(lag).slice(1)} after`} ${first.name} reported it: "${topic.items[0].title.slice(0, 160)}"`;
        this.alert(chat, topic, 'hot', detail, `${a.burst.length} messages from ${people} people about ${clean(topic.label, 60)}, ${lag < 60 ? 'right after' : `${formatLag(lag).slice(1)} after`} ${first.name} reported it.`);
      } else if (a.level === 'first') {
        const item = topic.items[0];
        if (!item.backlog && item.seenAt >= t - 1800) {
          const lead = -a.burst[0].lag;
          const detail = `${a.burst.length} messages from ${people} people about ${topic.label}, ${formatLag(-lead)} the first report (${first.name}: "${item.title.slice(0, 160)}")`;
          this.alert(chat, topic, 'first', detail, `${a.burst.length} messages from ${people} people about ${clean(topic.label, 60)}, ${formatLag(-lead)} ${first.name} reported it.`);
        }
      }
      // The first mention after the report, seen live: one activity line, no notification.
      const echo = hits.filter((h) => h.lag >= 0).sort((x, y) => x.date - y.date)[0];
      if (echo && echo.date >= t - LIVE_S && store.addNewsAlert({ chatId: chat.chatId, topicId, kind: 'echo', at: t, detail: '' })) {
        const who = users.get(echo.userId)?.displayName ?? 'someone';
        activity?.event('news', 'in the group', chat.title, `${topic.label}: ${who} brought it up ${echo.lag < 60 ? 'right after' : `${formatLag(echo.lag).slice(1)} after`} ${first.name} (#${echo.messageId})`);
      }
    }
  }

  private alert(chat: ChatRow, topic: Topic, kind: 'hot' | 'first', detail: string, body: string): void {
    const { store, now, activity, notifier, config } = this.d;
    const t = now();
    if (!store.addNewsAlert({ chatId: chat.chatId, topicId: topic.id, kind, at: t, detail })) return; // already raised
    activity?.event('news', kind === 'hot' ? 'news in the group' : 'group was first', chat.title, detail);
    this.notified = this.notified.filter((x) => x > t - 3600);
    if (!notifier || !config.newsNotify) return;
    if (this.notified.length >= MAX_NOTIFY_PER_HOUR) return; // the console still shows it
    this.notified.push(t);
    notifier.notify({ kind: kind === 'hot' ? 'news' : 'ahead', group: chat.title, body });
  }

  // ── views ──────────────────────────────────────────────────────────────

  view(opts: { limit?: number; chatId?: number } = {}): RadarView {
    const { store, now } = this.d;
    const t = now();
    const day = t - 86_400;
    const counts = store.newsItemCounts(day);
    const chats = new Map(store.listChats(false).map((c) => [c.chatId, c]));
    const names = new Map<number, Map<number, string>>();
    const nameOf = (chatId: number, userId: number) => {
      let m = names.get(chatId);
      if (!m) names.set(chatId, (m = new Map([...store.users(chatId)].map(([id, u]) => [id, u.displayName]))));
      return m.get(userId) ?? 'someone';
    };
    const textOf = new Map<string, string>();
    const msgText = (chatId: number, messageId: number, date: number) => {
      const k = `${chatId}:${messageId}`;
      if (!textOf.has(k)) for (const m of store.messages(chatId, date, date + 1)) textOf.set(`${chatId}:${m.messageId}`, m.text);
      return textOf.get(k) ?? '';
    };
    const sources: SourceView[] = store.newsSources().map((s) => {
      const delays = store.newsDelays(s.id).sort((a, b) => a - b);
      return {
        id: s.id,
        kind: s.kind,
        name: s.name,
        url: s.url,
        tier: s.tier,
        everyS: s.everyS,
        enabled: s.enabled,
        builtin: s.builtin,
        lastFetchAt: s.kind === 'telegram' ? (Number(store.getKv(`reader_caught_up:${s.id.slice(3)}`) ?? 0) || null) : s.lastFetchAt,
        lastOkAt: s.lastOkAt,
        error: s.lastError,
        items24h: counts.get(s.id) ?? 0,
        delayMin: delays.length ? Math.round(delays[Math.floor(delays.length / 2)] / 60) : null,
      };
    });
    // Per group and topic: what came after the news, and what came before it only if it was a lead.
    const grouped = new Map<string, Hit[]>();
    for (const h of [...this.hits.values()].flat()) {
      if (opts.chatId && h.chatId !== opts.chatId) continue;
      const k = `${h.chatId}:${h.topicId}`;
      grouped.set(k, [...(grouped.get(k) ?? []), h]);
    }
    const allHits = [...grouped.values()].flatMap((hs) => shownHits(hs));
    // The best-ranked topics, and every topic a group talked about whatever its rank.
    const echoed = new Set(allHits.map((h) => h.topicId));
    const top = new Set(this.topics.slice(0, opts.limit ?? 40).map((x) => x.id));
    const keywords: TopicView[] = this.topics.filter((x) => top.has(x.id) || echoed.has(x.id)).map((topic) => {
      const groups: GroupEcho[] = [];
      const mine = allHits.filter((h) => h.topicId === topic.id);
      for (const chatId of new Set(mine.map((h) => h.chatId))) {
        const hs = mine.filter((h) => h.chatId === chatId).sort((a, b) => a.date - b.date);
        const a = attention(hs);
        groups.push({
          chatId,
          title: chats.get(chatId)?.title ?? String(chatId),
          count: hs.length,
          people: new Set(hs.map((h) => h.userId)).size,
          firstLag: hs[0].lag,
          level: a?.level ?? 'echo',
          messages: hs.slice(0, 12).map((h) => {
            const text = msgText(chatId, h.messageId, h.date).slice(0, 400);
            return { messageId: h.messageId, date: h.date, author: nameOf(chatId, h.userId), text, terms: h.terms, lag: h.lag, marks: matchSpans(text, this.lex, new Set(h.keys)) };
          }),
        });
      }
      groups.sort((a, b) => b.count - a.count);
      return {
        id: topic.id,
        label: topic.label,
        score: topic.score,
        firstAt: topic.firstAt,
        lastAt: topic.lastAt,
        headline: topic.items[0].title,
        link: topic.items[0].link,
        items: topic.items.length,
        terms: topic.terms.filter((x) => !x.generic).slice(0, 8).map((x) => x.label),
        sources: topic.sources.map((s) => ({ name: s.name, tier: s.tier, at: s.firstAt, link: s.link, title: s.title })),
        groups,
      };
    });
    const hits = allHits
      .sort((a, b) => b.date - a.date)
      .slice(0, 80)
      .map((h) => {
        const topic = this.byId.get(h.topicId);
        const text = msgText(h.chatId, h.messageId, h.date).slice(0, 400);
        return {
          chatId: h.chatId,
          group: chats.get(h.chatId)?.title ?? String(h.chatId),
          topicId: h.topicId,
          label: topic?.label ?? '',
          messageId: h.messageId,
          date: h.date,
          author: nameOf(h.chatId, h.userId),
          text,
          terms: h.terms,
          lag: h.lag,
          source: topic?.sources[0]?.name ?? '',
          marks: matchSpans(text, this.lex, new Set(h.keys)),
        };
      });
    const alerts = store.newsAlerts(day).filter((a) => a.kind !== 'echo').map((a) => ({ ...a, group: chats.get(a.chatId)?.title ?? String(a.chatId) }));
    return { at: t, live: Boolean(this.d.live), enabled: this.enabled, sources, items24h: [...counts.values()].reduce((s, x) => s + x, 0), keywords, hits, alerts };
  }

  // ── the owner's changes (console only) ─────────────────────────────────

  async addFeed(rawUrl: string, name: string): Promise<{ ok: boolean; message: string }> {
    const url = checkFeedUrl(rawUrl);
    if (typeof url !== 'string') return { ok: false, message: url.error };
    const id = `feed-${hashId(url)}`;
    if (this.d.store.newsSource(id)) return { ok: false, message: 'That feed is already on the list.' };
    const src = this.d.store.ensureNewsSource({ id, kind: 'rss', name: name.trim().slice(0, 60) || new URL(url).hostname.replace(/^www\./, ''), url, tier: 1, everyS: 300 });
    const r = await this.fetchSource(src);
    const now = this.d.store.newsSource(id)!;
    if (now.lastError) {
      this.d.store.removeNewsSource(id);
      return { ok: false, message: `Not added: ${now.lastError}.` };
    }
    this.d.activity?.event('console', 'news source added', now.name, `${url}: ${r.status}`);
    return { ok: true, message: `Added ${now.name}: ${r.status} item${r.added === 1 ? '' : 's'} from the last day. Checked every 5 minutes.` };
  }

  setEnabled(id: string, on: boolean): { ok: boolean; message: string } {
    const s = this.d.store.newsSource(id);
    if (!s) return { ok: false, message: 'Unknown news source.' };
    this.d.store.updateNewsSource(id, { enabled: on });
    this.d.activity?.event('console', on ? 'news source on' : 'news source off', s.name, on ? 'its news counts again' : 'its news no longer counts for keywords');
    this.scheduleRebuild();
    return { ok: true, message: `${s.name}: ${on ? 'on' : 'off'}.` };
  }

  remove(id: string): { ok: boolean; message: string } {
    const s = this.d.store.newsSource(id);
    if (!s) return { ok: false, message: 'Unknown news source.' };
    if (s.builtin || s.kind === 'telegram') return { ok: false, message: 'Built-in sources and Telegram channels can be switched off, not removed.' };
    this.d.store.removeNewsSource(id);
    this.d.activity?.event('console', 'news source removed', s.name, s.url ?? '');
    this.scheduleRebuild();
    return { ok: true, message: `Removed ${s.name}.` };
  }
}

/** Every form a key can take in a message (for the database prefilter). */
function formsOf(key: string): string[] {
  const c = CONCEPTS.find((x) => x.key === key);
  if (!c) return [key];
  return [...c.loose, ...c.strict, ...c.cjk];
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** A feed address the owner typed: http(s), a public host name, no credentials in it. */
export function checkFeedUrl(raw: string): string | { error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: 'That is not a web address. Paste the feed link (it usually ends in /rss, /feed or .xml).' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https feeds.' };
  if (u.username || u.password) return { error: 'No user name or password in the address.' };
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\[|^(\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    !host.includes('.');
  if (privateHost) return { error: 'Only public feeds (a host name on the internet, not an IP address or this computer).' };
  return u.toString();
}
