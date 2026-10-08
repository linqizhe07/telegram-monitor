// Finding groups worth reading: the topics one click searches for, and how a group found that way
// is judged from what the account can see without joining (its title, Telegram's own flags, and a
// sample of its latest messages): likely scam, closed, low quality, worth a look, or good.
// Pure functions; the service (src/discover.ts) does the searching.

import { denoise, onTopic } from './denoise.ts';
import { inviteHash } from './invite-rules.ts';
import type { StoredMessage } from './store.ts';

export type TopicId = 'hyperliquid' | 'crypto' | 'rwa' | 'stocks' | 'custom';

/** What a search judges: groups (people talking), channels (one voice posting), or both. */
export type Kind = 'groups' | 'channels' | 'both';
export const KINDS: readonly Kind[] = ['groups', 'channels', 'both'];

export interface Topic {
  id: TopicId;
  label: string;
  /** What is typed into Telegram's search (each costs one request). */
  queries: string[];
  /** Typed as well when groups are wanted: the words group titles carry ("chat", "community", "交流"). */
  groupQueries: string[];
  /** Words that make a message or a title about the topic (lower case; Chinese as is). Empty: crypto in general. */
  terms: string[];
  /** Names people impersonate around this topic. */
  brands: string[];
  /** The project's own sites: the Telegram links they carry are the official ones. */
  officialSites: string[];
  /** Official handles, read from those sites on 2026-10-07 (the sites are read again when searching). */
  officialHandles: string[];
  /** Channels to ask Telegram for similar ones (only those the account already reads are used). */
  seeds: string[];
}

export const TOPICS: Record<Exclude<TopicId, 'custom'>, Topic> = {
  hyperliquid: {
    id: 'hyperliquid',
    label: 'Hyperliquid',
    queries: ['hyperliquid', 'hyperliquid 中文', 'hyperliquid traders', 'hyperevm'],
    groupQueries: ['hyperliquid chat', 'hyperliquid community'],
    terms: ['hyperliquid', 'hype', 'hyperevm', 'hypercore', 'hlp', 'purr', 'hypurr', 'perp', 'perps', '永续', '合约'],
    brands: ['hyperliquid', 'hyperevm'],
    officialSites: ['https://hyperliquid.xyz'],
    officialHandles: ['hyperliquid_announcements'],
    seeds: ['hyperliquid_announcements'],
  },
  crypto: {
    id: 'crypto',
    label: 'Crypto',
    queries: ['crypto', 'bitcoin', 'defi', '币圈'],
    groupQueries: ['crypto chat', '币圈 交流'],
    terms: [],
    brands: ['binance', 'okx', 'bybit', 'coinbase', 'bitget', 'kucoin', 'metamask', 'trust wallet', 'ledger', 'phantom', 'uniswap', 'tether', '币安', '欧易'],
    officialSites: [],
    officialHandles: [],
    seeds: ['cointelegraph', 'WatcherGuru'],
  },
  rwa: {
    id: 'rwa',
    label: 'RWA',
    queries: ['RWA', 'real world assets', 'tokenized assets', 'RWA 中文'],
    groupQueries: ['RWA chat', 'RWA community'],
    terms: ['rwa', 'real world asset', 'real-world asset', 'tokeniz', 'treasur', 'private credit', 'bond', '代币化', '现实资产', '现实世界资产', '美债', 'ondo', 'plume', 'centrifuge', 'securitize', 'buidl', 'mantra', 'maple', 'superstate', 'xstocks'],
    brands: ['ondo', 'securitize', 'blackrock', 'plume', 'centrifuge', 'mantra', 'franklin'],
    officialSites: [],
    officialHandles: [],
    seeds: [],
  },
  stocks: {
    id: 'stocks',
    label: 'Stocks',
    queries: ['stocks', 'stock market', '美股', 'tokenized stocks'],
    groupQueries: ['stocks chat', '美股 交流'],
    terms: ['stock', 'nasdaq', 'nyse', 's&p', 'spx', 'spy', 'qqq', 'earnings', 'ipo', 'dividend', '美股', '港股', 'a股', '股票', '财报', '纳指', '标普', '个股', 'xstocks', 'tsla', 'nvda', 'aapl', 'msft', 'amzn', 'googl', '英伟达', '特斯拉'],
    brands: ['robinhood', 'etoro', 'webull', 'futu', '富途', 'moomoo', 'tiger', '老虎', 'ibkr', 'interactive brokers', 'schwab'],
    officialSites: [],
    officialHandles: [],
    seeds: [],
  },
};

/** A topic from the owner's own words: what they typed is the query, and its words are the terms. */
export function customTopic(query: string): Topic {
  const q = query.trim().slice(0, 64);
  const words = q.toLowerCase().split(/[\s,，、|]+/).filter((w) => w.length >= 2);
  const groupWord = /\p{Script=Han}/u.test(q) ? '交流' : 'chat';
  return { id: 'custom', label: q, queries: [q], groupQueries: [`${q} ${groupWord}`], terms: words, brands: [], officialSites: [], officialHandles: [], seeds: [] };
}

/** What a search turned up, before anything is read. */
export interface Found {
  chatId: number;
  title: string;
  username: string | null;
  type: 'group' | 'channel';
  members: number | null;
  verified: boolean;
  scam: boolean;
  fake: boolean;
  /** Restriction reasons Telegram gives (platform: reason). */
  restricted: string[];
  /** How it was found: 'search "hyperliquid"', 'similar to @x', 'linked by 3 people in your groups'. */
  via: string[];
  /** How many different people in the watched groups linked to it. */
  mentions: number;
  /** A channel's discussion group (Telegram links the two): the channel's username. */
  discusses?: string | null;
}

/** The chat Telegram links a group or channel to: the channel a group discusses, or the group a channel's readers talk in. */
export interface Linked {
  username: string | null;
  title: string;
  type: 'group' | 'channel';
  /** One of the handles the project's own site links. */
  official: boolean;
}

/** What a read-only look saw (src/discover.ts), with the sampled messages. */
export interface Seen {
  readable: boolean;
  members: number | null;
  /** Members online at the full look; null without one, or when Telegram does not say. */
  online: number | null;
  /** Its description, from the full look ('' without one). */
  about: string;
  /** Messages a day: the last week's average, or the rate over what the sample covers (see perDayOf); null when unknown. */
  perDay: number | null;
  newestAt: number | null;
  /** Human messages sampled (bots left out), newest last; the authors' ids are in userId. */
  sample: StoredMessage[];
  botMessages: number;
  sampled: number;
  joinRequest: boolean;
  /** Links behind text or in buttons, with the buttons' labels, by message id: read for scams with the text. */
  hidden?: Record<number, string>;
  /** "Verify you are human" posts whose button or hidden link leads to a bot or a site, and how many other messages people wrote. */
  portal?: { posts: number; others: number } | null;
  /** A channel's usual views per post (see typicalViews); null for groups, or with too few posts. */
  views?: number | null;
  /** The chat Telegram links it to, from the full look. */
  linked?: Linked | null;
}

export type Verdict = 'good' | 'ok' | 'low' | 'closed' | 'scam';

export interface Assessed {
  chatId: number;
  title: string;
  username: string | null;
  /** Its public link, or null without a username. */
  link: string | null;
  type: 'group' | 'channel';
  members: number | null;
  perDay: number | null;
  /** Different people among the sampled messages (a channel posts as itself). */
  speakers: number | null;
  sampled: number;
  language: 'zh' | 'en' | 'mixed' | null;
  newestAt: number | null;
  /** Members online at the full look (groups); null when not known. */
  online: number | null;
  /** A channel's usual views per post; null for groups or when not known. */
  views: number | null;
  verdict: Verdict;
  score: number;
  good: string[];
  bad: string[];
  via: string[];
  /** Private: found by an invite link shared in the watched groups, and only its cover was read. */
  private?: boolean;
  /** Not in the previous result of the same search. */
  isNew?: boolean;
  /** Its verdict in the previous result of the same search, when that was different. */
  was?: Verdict | null;
}

// ── scams ──────────────────────────────────────────────────────────────────

const CLAIM = /(official|support|help ?desk|customer|service|admin|airdrop|claim|giveaway|reward|bonus|refund|recovery|官方|客服|技术支持|售后|空投|领取|福利|赠送|退款|找回)/i;
const DISCLAIMED = /(unofficial|not official|fan ?club|非官方|粉丝)/i;

/** Letters people swap to fake a name: 0→o, 1/i/I→l, rn→m, vv→w. */
function unconfuse(s: string): string {
  return s.toLowerCase().replace(/0/g, 'o').replace(/[1i]/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w');
}

/**
 * A name that claims to be a brand's official, support or airdrop group without being one: not
 * verified by Telegram, not among the handles the brand's own site links, and the brand plus a claim
 * word in its title or username. Also a look-alike spelling of the brand. Null when it claims nothing.
 */
export function impersonation(f: Pick<Found, 'title' | 'username' | 'verified'>, topic: Topic, official: string[]): string | null {
  const name = `${f.title} ${f.username ?? ''}`;
  const lower = name.toLowerCase();
  const handle = (f.username ?? '').toLowerCase();
  if (official.some((h) => h.toLowerCase() === handle)) return null;
  for (const brand of topic.brands) {
    const b = brand.toLowerCase();
    const plain = lower.includes(b);
    const lookalike = !plain && unconfuse(name).includes(unconfuse(b));
    if (lookalike) return `its name imitates "${brand}" with look-alike letters`;
    if (plain && !f.verified && CLAIM.test(name) && !DISCLAIMED.test(name)) {
      const real = official.length ? ` (${brand}'s own site links only ${official.map((h) => `@${h}`).join(', ')})` : '';
      return `it claims to be ${brand}'s official, support or airdrop group, without Telegram's verified badge${real}`;
    }
  }
  return null;
}

// Selling, soliciting or draining: what scam and promotion groups are full of. Talk about seed
// phrases alone is not here: real communities warn about them all the time.
const SCAMMY = [
  /(t\.me|telegram\.me)\/(\+|joinchat\/)/i,
  /\b(connect|sync|validate|verify|rectify|restore)\s+(your\s+)?wallet\b/i,
  // Asking for a seed phrase, not warning against it ("never share your seed phrase").
  /(?<!(never|not|don'?t|do not)\s{1,3})(enter|share|send|submit|type)\s+(your\s+)?((seed|recovery|secret)\s*(phrase|words)|private\s*key)/i,
  /\b(claim|airdrop)\b.{0,40}\b(now|live|link|here|free|today)\b/i,
  /(guaranteed|risk[- ]?free)\s+(profit|return)|double your|\b\d{2,4}x\s+(gem|profit|returns?)\b|vip\s*(signal|group|channel)|pump\s*(signal|group)/i,
  /\b(dm|pm|inbox|message)\s+(me|admin|support|us)\b/i,
  /(稳赚|保本|翻倍|日入|月入|带单|喊单|内幕消息|拉盘|跟单|vip群|私聊我|加我|领取空投|免费领)/i,
  // Drainer sites name themselves after what they promise.
  /https?:\/\/[^\s/]*(claim|airdrop|reward|connect-?wallet|wallet-?connect|validat|rectif|restore)[^\s]*/i,
];

/** Whether a message sells, solicits or drains; pass the links hidden behind its text and buttons along with it. */
export function scammy(text: string): boolean {
  return SCAMMY.some((re) => re.test(text));
}

const VERIFY = /(verify|verification|captcha|are you (a )?human|not a robot|safeguard|guardian|人机验证|点击验证|完成验证|验证身份)/i;
const OUTSIDE = /(t\.me|telegram\.me)\/[A-Za-z0-9_]+bot\b|https?:\/\/(?!(www\.)?(t|telegram)\.me\/)\S+/i;
/** Verification services real communities use; a button to one of these is not a portal. */
const KNOWN_GATES = /(collab\.?land|guild\.xyz|guildxyz|missrose_bot|shieldy_bot|combot|grouphelpbot)/i;

/**
 * A "verify you are human" post whose button or hidden link leads to a bot or a site: how fake
 * verification portals catch people (the bot asks for the Telegram login code, or for a command to
 * paste and run). Real anti-spam checks answer inside the group, with buttons that link nowhere.
 */
export function portalPost(text: string, buttons: string[], hiddenUrls: string[]): boolean {
  return VERIFY.test(`${text} ${buttons.join(' ')}`) && hiddenUrls.some((u) => OUTSIDE.test(u) && !KNOWN_GATES.test(u));
}

/** Invite hashes a message carries (t.me/+…, t.me/joinchat/…), checked like any invite the owner pastes. */
export function inviteHashes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/gi)) {
    const h = inviteHash(m[0]);
    if (h) out.add(h);
  }
  return [...out];
}

// ── language and topic ─────────────────────────────────────────────────────

export function languageOf(sample: { text: string }[]): 'zh' | 'en' | 'mixed' | null {
  let han = 0;
  let latin = 0;
  for (const m of sample) {
    han += (m.text.match(/\p{Script=Han}/gu) ?? []).length;
    latin += (m.text.match(/[A-Za-z]/g) ?? []).length;
  }
  // A Chinese character says about as much as a few Latin letters.
  const zh = han * 3;
  if (zh + latin < 40) return null;
  const share = zh / (zh + latin);
  return share > 0.7 ? 'zh' : share < 0.2 ? 'en' : 'mixed';
}

/** Whether a text (a name, a description, a message) is about the topic. */
export function isAbout(text: string, topic: Topic): boolean {
  return about(text, topic);
}

function about(text: string, topic: Topic): boolean {
  if (topic.terms.length === 0) return onTopic(text);
  const t = text.toLowerCase();
  return topic.terms.some((w) => t.includes(w));
}

// ── the judgement ──────────────────────────────────────────────────────────

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const n = (x: number) => x.toLocaleString('en-US');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Messages a day from the latest ones (as Telegram returned them, newest first or not): the last
 * week's average when they reach back a week; else, when they are all the chat has (fewer than a
 * full page of `limit`), all of them over at least a day; else the rate over the time they cover,
 * by message ids, so deleted messages count too. Deleted ones come back without a date.
 */
export function perDayOf(batch: { id: number; date?: number }[], now: number, limit = 100): number {
  const msgs = batch.filter((m): m is { id: number; date: number } => Number.isFinite(m.date));
  if (msgs.length === 0) return 0;
  const week = now - 7 * 86_400;
  const oldest = Math.min(...msgs.map((m) => m.date));
  if (oldest <= week) return msgs.filter((m) => m.date > week).length / 7;
  if (batch.length < limit) return (msgs.length * 86_400) / Math.max(86_400, now - oldest);
  const ids = msgs.map((m) => m.id);
  return ((Math.max(...ids) - Math.min(...ids) + 1) * 86_400) / Math.max(3600, now - oldest);
}

// Figures (12%, $4.2B, 3,000, 1.5亿), a ticker ($HYPE), a link, a time: what a post that says something carries.
const FACT = /\d[\d,.]*\s?(%|k\b|m\b|b\b|bn\b|万|亿|美元|usd|usdt)|[$€¥£]\s?\d|\$[A-Za-z]{2,6}\b|https?:\/\/|\b\d{1,2}:\d{2}\b|\b\d{4,}\b|\b\d+(\.\d+)?x\b/i;

/**
 * Whether a post carries something: figures, a ticker or a link, or a real paragraph; not a
 * one-liner, a sticker or a bare repost. A Chinese character counts as two and a half letters.
 */
export function substantive(text: string): boolean {
  const t = text.replace(/\[(forwarded[^\]]*|sticker[^\]]*|photo|gif|video|video note|voice[^\]]*|document[^\]]*|audio[^\]]*)\]/gi, '').trim();
  const han = (t.match(/\p{Script=Han}/gu) ?? []).length;
  const size = t.length - han + han * 2.5;
  if (size < 40) return false;
  return FACT.test(t) || size >= 160;
}

/** A channel's usual views per post: the median of its latest 30 posts older than six hours (views still grow before that); null under five. */
export function typicalViews(posts: { date: number; views?: number | null }[], now: number): number | null {
  const v = [...posts]
    .sort((a, b) => b.date - a.date)
    .filter((p) => typeof p.views === 'number' && p.date < now - 6 * 3600)
    .slice(0, 30)
    .map((p) => p.views as number)
    .sort((a, b) => a - b);
  return v.length >= 5 ? v[Math.floor(v.length / 2)] : null;
}

/**
 * Judges a group or channel from what a read-only look saw. Telegram's SCAM/FAKE flags, a name
 * claiming to be official, a feed of selling and soliciting, or a "verify you are human" portal
 * make it a likely scam; a closed door leaves it unjudged (closed); otherwise a score from topic,
 * activity, speakers, signal and size, less what is wrong (members nobody speaks to or nobody opens,
 * subscribers who never see a post, one account doing the talking, long silence).
 */
export function assess(f: Found, seen: Seen | null, topic: Topic, official: string[], now: number): Assessed {
  const base: Assessed = {
    chatId: f.chatId,
    title: f.title,
    username: f.username,
    link: f.username ? `https://t.me/${f.username}` : null,
    type: f.type,
    members: seen?.members ?? f.members,
    perDay: seen?.perDay ?? null,
    speakers: null,
    sampled: seen?.sampled ?? 0,
    language: seen ? languageOf(seen.sample) : null,
    newestAt: seen?.newestAt ?? null,
    online: seen?.online ?? null,
    views: seen?.views ?? null,
    verdict: 'low',
    score: 0,
    good: [],
    bad: [],
    via: f.via,
  };
  const bad = base.bad;
  const good = base.good;
  const isOfficial = Boolean(f.username && official.some((h) => same(h, f.username!)));
  // A channel's discussion group: Telegram itself links the two, so the official channel's group is official too.
  const discusses = f.type === 'group' ? (f.discusses ?? (seen?.linked?.type === 'channel' ? seen.linked.username : null)) : null;
  const officialGroup = Boolean(discusses && official.some((h) => same(h, discusses)));
  if (isOfficial) good.push(`official: the project's own site links @${f.username}`);
  if (officialGroup) good.push(`official: the discussion group of @${discusses}, the project's own channel`);
  else if (discusses) good.push(`the discussion group of @${discusses}`);
  if (f.type === 'channel' && seen?.linked?.type === 'group') good.push(`its readers talk in ${seen.linked.username ? `@${seen.linked.username}` : seen.linked.title}, its discussion group`);
  if (f.verified) good.push("Telegram's verified badge");
  if (f.mentions >= 2) good.push(`linked by ${f.mentions} people in your groups`);

  // Likely scams, decided before anything else.
  if (f.scam || f.fake) bad.push(`Telegram itself marks it ${f.scam ? 'SCAM' : 'FAKE'}`);
  const fakeName = officialGroup ? null : impersonation(f, topic, official);
  if (fakeName) bad.push(fakeName);
  if (f.restricted.some((r) => /porn|spam|copyright|scam|fraud/i.test(r))) bad.push(`Telegram restricts it: ${f.restricted.join(', ')}`);
  const sample = seen?.sample ?? [];
  const textOf = (m: StoredMessage) => (seen?.hidden?.[m.messageId] ? `${m.text} ${seen.hidden[m.messageId]}` : m.text);
  const scams = sample.filter((m) => scammy(textOf(m)));
  const scamPeople = new Set(scams.map((m) => m.userId)).size;
  const scamShare = sample.length ? scams.length / sample.length : 0;
  if (sample.length >= 10 && scamShare >= 0.4 && (f.type === 'channel' || scamPeople >= 2 || scams.length >= 10)) {
    bad.push(`${pct(scamShare)} of its latest messages sell, solicit or push airdrops ("DM me", wallet links, signals)`);
  }
  const portal = seen?.portal ?? null;
  if (portal && portal.posts > 0 && portal.others < 5) {
    bad.push('little but a "verify you are human" button to an outside bot or site: fake verification bots like this take over Telegram accounts (they ask for the login code, or for a command to paste and run)');
  }
  if (bad.length) return { ...base, verdict: 'scam', score: 0 };

  if (!seen || !seen.readable) {
    bad.push(seen?.joinRequest ? 'not readable from outside, and joining needs an admin to approve' : 'not readable from outside: only members see what is said');
    return { ...base, verdict: 'closed', score: 0 };
  }

  // What it is about, and how alive.
  const humans = sample.length;
  const people = new Set(sample.map((m) => m.userId)).size;
  const members = base.members ?? 0;
  base.speakers = f.type === 'group' ? people : null;
  const titleHit = about(`${f.title} ${f.username ?? ''} ${seen.about}`, topic) || discusses ? 1 : 0;
  const share = humans ? sample.filter((m) => about(m.text, topic)).length / humans : 0;
  const relevance = humans >= 5 ? 0.35 * titleHit + 0.65 * share : titleHit;
  const d = denoise([...sample].sort((a, b) => a.date - b.date || a.messageId - b.messageId));
  const removed = Object.values(d.removed).reduce((a, b) => a + b, 0);
  // Too few people's messages to say anything about noise: count it as all noise.
  const noise = humans >= 10 ? removed / humans : 1;
  const perDay = seen.perDay ?? 0;
  const silentDays = seen.newestAt ? (now - seen.newestAt) / 86_400 : Infinity;
  const fresh = silentDays <= 1 ? 1 : silentDays <= 7 ? 0.4 : 0;
  const size = clamp(Math.log10(1 + members) / 5);

  if (share >= 0.3) good.push(`${pct(share)} of the latest messages are about ${topic.id === 'crypto' ? 'crypto and markets' : topic.label}`);
  else if (humans >= 10 && share < 0.1) bad.push(`little of what is said is about ${topic.id === 'crypto' ? 'crypto' : topic.label} (${pct(share)})`);

  let score: number;
  if (/(not active|inactive|no longer|deprecated|abandoned|moved to|closed|已停用|停止运营|已关闭|已迁移|搬家)/i.test(`${f.title} ${seen.about}`)) bad.push('its own title or description says it is no longer active');
  if (f.type === 'group') {
    const activity = clamp(Math.log10(1 + perDay) / Math.log10(501));
    const speakers = clamp(people / 25);
    score = 30 * relevance + 20 * activity + 20 * speakers + 15 * (1 - noise) + 10 * size + 5 * fresh;
    if (perDay >= 20 && people >= 10) good.push(`${n(Math.round(perDay))} messages a day; ${people} people in the last ${humans} messages`);
    if (seen.sampled >= 20 && humans < 10) bad.push(`hardly anyone writes: ${humans} of its last ${seen.sampled} messages are from people`);
    if (perDay >= 200 && people <= 5 && humans >= 10) bad.push(`${n(Math.round(perDay))} messages a day from ${people} accounts: bots or spam, not a conversation`);
    if (members >= 3000 && perDay < 2) bad.push(`${n(members)} members but ${perDay < 1 ? 'hardly a message' : `${perDay.toFixed(1)} messages`} a day: members bought, or abandoned`);
    if (seen.online !== null && members >= 1000 && seen.online <= Math.max(2, members * 0.001)) bad.push(`${n(members)} members but ${seen.online} online: members bought, or nobody opens it`);
    else if (seen.online !== null && seen.online >= 20 && seen.online >= members * 0.02) good.push(`${n(seen.online)} of ${n(members)} members online`);
    const top = Math.max(0, ...[...new Set(sample.map((m) => m.userId))].map((id) => sample.filter((m) => m.userId === id).length));
    if (humans >= 5 && people <= 2) bad.push(`only ${people === 1 ? 'one account writes' : 'two accounts write'} there: not a conversation`);
    else if (humans >= 20 && top / humans >= 0.6) bad.push(`one account writes ${pct(top / humans)} of what is said`);
    if (seen.sampled >= 20 && seen.botMessages / seen.sampled >= 0.5) bad.push(`bots write ${pct(seen.botMessages / seen.sampled)} of its messages`);
  } else {
    const activity = clamp(Math.log10(1 + perDay) / Math.log10(31));
    // A channel is worth what its posts carry: how many say something, not how many there are.
    const dense = humans ? sample.filter((m) => substantive(m.text)).length / humans : 0;
    score = 30 * relevance + 20 * activity + 15 * dense + 10 * (1 - noise) + 15 * size + 10 * fresh;
    if (perDay >= 1) good.push(`${perDay >= 10 ? n(Math.round(perDay)) : perDay.toFixed(1)} posts a day`);
    if (humans >= 10 && dense >= 0.6) good.push(`dense: ${pct(dense)} of its posts carry figures, tickers, links or a real paragraph`);
    else if (humans >= 10 && dense < 0.2) bad.push(`thin: only ${pct(dense)} of its posts say anything (the rest are one-liners, stickers or bare reposts)`);
    if (members >= 20_000 && perDay < 0.2) bad.push(`${n(members)} subscribers but it hardly posts`);
    const views = seen.views ?? null;
    if (views !== null && members >= 1000 && views < members * 0.01 && perDay < 50) bad.push(`${n(members)} subscribers but a post is seen by about ${n(views)}: subscribers bought`);
    else if (views !== null && members > 0 && views >= members * 0.1) good.push(`a post is seen by about ${n(views)} (${pct(views / members)} of subscribers)`);
  }
  if (humans >= 10 && noise <= 0.2) good.push(`little noise (${pct(noise)} stickers, chatter or spam)`);
  if (humans >= 10 && noise >= 0.5) bad.push(`mostly noise (${pct(noise)} stickers, chatter or spam)`);
  if (scamShare >= 0.15) bad.push(`${pct(scamShare)} of the latest messages sell or solicit`);
  if (portal && portal.posts > 0) bad.push(`asks people to "verify" through a button to an outside bot or site (${portal.posts} such post${portal.posts === 1 ? '' : 's'}): never press those`);
  if (silentDays > 7) bad.push(seen.newestAt ? `silent for ${Math.round(silentDays)} days` : 'no messages to see');

  if (f.verified) score += 5;
  if (isOfficial || officialGroup) score += 5;
  score += Math.min(10, 3 * f.mentions);
  score -= 15 * bad.length;
  score = Math.max(0, Math.min(100, Math.round(score)));
  // Not worth a look, however good it once was: a group two weeks without a word (a channel, a month), or a group one or two accounts talk in.
  const dead = silentDays > (f.type === 'group' ? 14 : 30) || (f.type === 'group' && humans >= 5 && people <= 2);
  const verdict: Verdict = dead ? 'low' : score >= 60 && bad.length === 0 ? 'good' : score >= 35 ? 'ok' : 'low';
  return { ...base, verdict, score };
}

/** The cover of a private group or channel, as an invite link shows it to someone outside. */
export interface Cover {
  /** The invite hash (for the owner's Open button; never shown to Claude). */
  hash: string;
  /** Its chat id when Telegram gave the chat, else one made from the hash (for Hide). */
  chatId: number;
  title: string;
  about: string;
  members: number | null;
  type: 'group' | 'channel';
  verified: boolean;
  scam: boolean;
  fake: boolean;
  requestNeeded: boolean;
  paid: boolean;
  /** How many different people in the watched groups shared the link. */
  people: number;
}

/** A private group found by an invite link shared in the watched groups: only its cover can be judged, so it is closed or a likely scam. */
export function assessPrivate(c: Cover, topic: Topic, official: string[]): Assessed {
  const base: Assessed = {
    chatId: c.chatId,
    title: c.title,
    username: null,
    link: `https://t.me/+${c.hash}`,
    type: c.type,
    members: c.members,
    perDay: null,
    speakers: null,
    sampled: 0,
    language: languageOf([{ text: `${c.title} ${c.about}` }]),
    newestAt: null,
    online: null,
    views: null,
    verdict: 'closed',
    score: 0,
    good: [],
    bad: [],
    via: [`invite link shared by ${c.people} people in your groups`],
    private: true,
  };
  if (c.scam || c.fake) base.bad.push(`Telegram itself marks it ${c.scam ? 'SCAM' : 'FAKE'}`);
  const fakeName = impersonation({ title: c.title, username: null, verified: c.verified }, topic, official);
  if (fakeName) base.bad.push(fakeName);
  if (scammy(c.about)) base.bad.push('its description sells, solicits or pushes airdrops');
  if (base.bad.length) return { ...base, link: null, verdict: 'scam' };
  if (c.verified) base.good.push("Telegram's verified badge");
  if (about(`${c.title} ${c.about}`, topic)) base.good.push(`its name or description is about ${topic.id === 'crypto' ? 'crypto' : topic.label}`);
  base.good.push(`shared by ${c.people} people in your groups`);
  base.bad.push(`private: only members can read it${c.requestNeeded ? ', and joining needs an admin to approve' : ''}${c.paid ? '; membership is paid' : ''}`);
  return base;
}

/** Which of what was found to look at first: on-topic names and discussion groups, verified, linked by your groups, then size. */
export function priority(f: Found, topic: Topic): number {
  const name = `${f.title} ${f.username ?? ''}`;
  const pointed = f.via.some((v) => v.startsWith('linked from '));
  return (about(name, topic) || f.discusses ? 40 : 0) + Math.min(20, 4 * Math.log10(1 + (f.members ?? 0))) + (f.verified ? 15 : 0) + 8 * Math.min(3, f.mentions) + (f.type === 'group' ? 5 : 0) + (f.discusses ? 10 : 0) + (pointed ? 10 : 0);
}

/** Public usernames linked in a message (t.me/name), not invite links or bots. */
export function linkedUsernames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/gi)) {
    const u = m[1];
    if (/bot$/i.test(u) || /^(joinchat|addlist|share|proxy|socks|iv|c|s)$/i.test(u)) continue;
    out.add(u);
  }
  return [...out];
}

/**
 * Chats a description points to: its t.me links, and the @names it calls a chat ("Chat: @hl_chat",
 * "交流群 @hl_cn"); an @name after "contact" or "admin" is a person, and bots are left out.
 */
export function describedUsernames(text: string): string[] {
  const out = new Set(linkedUsernames(text));
  for (const m of text.matchAll(/(chat|group|community|discussion|discuss|交流|讨论|群|社区|社群)[^@\n]{0,24}(?<![\w@./])@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/gi)) {
    if (!/bot$/i.test(m[2])) out.add(m[2]);
  }
  return [...out];
}
