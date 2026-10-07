// Finding groups worth reading: the topics one click searches for, and how a group found that way
// is judged from what the account can see without joining (its title, Telegram's own flags, and a
// sample of its latest messages): likely scam, closed, low quality, worth a look, or good.
// Pure functions; the service (src/discover.ts) does the searching.

import { denoise, onTopic } from './denoise.ts';
import type { StoredMessage } from './store.ts';

export type TopicId = 'hyperliquid' | 'crypto' | 'rwa' | 'stocks' | 'custom';

export interface Topic {
  id: TopicId;
  label: string;
  /** What is typed into Telegram's search (each costs one request). */
  queries: string[];
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
  return { id: 'custom', label: q, queries: [q], terms: words, brands: [], officialSites: [], officialHandles: [], seeds: [] };
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
}

/** What a read-only look saw (src/probe.ts), with the sampled messages. */
export interface Seen {
  readable: boolean;
  members: number | null;
  online: number | null;
  about: string;
  /** Messages a day (from message ids, so deleted ones count too); null when unknown. */
  perDay: number | null;
  newestAt: number | null;
  /** Human messages sampled (bots left out), newest last; the authors' ids are in userId. */
  sample: StoredMessage[];
  botMessages: number;
  sampled: number;
  joinRequest: boolean;
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
  verdict: Verdict;
  score: number;
  good: string[];
  bad: string[];
  via: string[];
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
];

export function scammy(text: string): boolean {
  return SCAMMY.some((re) => re.test(text));
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

function about(text: string, topic: Topic): boolean {
  if (topic.terms.length === 0) return onTopic(text);
  const t = text.toLowerCase();
  return topic.terms.some((w) => t.includes(w));
}

// ── the judgement ──────────────────────────────────────────────────────────

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const n = (x: number) => x.toLocaleString('en-US');

/**
 * Judges a group or channel from what a read-only look saw. Telegram's SCAM/FAKE flags, a name
 * claiming to be official, or a feed of selling and soliciting make it a likely scam; a closed door
 * leaves it unjudged (closed); otherwise a score from topic, activity, speakers, signal and size,
 * less what is wrong (members nobody speaks to, one account doing the talking, long silence).
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
    verdict: 'low',
    score: 0,
    good: [],
    bad: [],
    via: f.via,
  };
  const bad = base.bad;
  const good = base.good;
  const isOfficial = Boolean(f.username && official.some((h) => h.toLowerCase() === f.username!.toLowerCase()));
  if (isOfficial) good.push(`official: the project's own site links @${f.username}`);
  if (f.verified) good.push("Telegram's verified badge");
  if (f.mentions >= 2) good.push(`linked by ${f.mentions} people in your groups`);

  // Likely scams, decided before anything else.
  if (f.scam || f.fake) bad.push(`Telegram itself marks it ${f.scam ? 'SCAM' : 'FAKE'}`);
  const fakeName = impersonation(f, topic, official);
  if (fakeName) bad.push(fakeName);
  if (f.restricted.some((r) => /porn|spam|copyright|scam|fraud/i.test(r))) bad.push(`Telegram restricts it: ${f.restricted.join(', ')}`);
  const sample = seen?.sample ?? [];
  const scams = sample.filter((m) => scammy(m.text));
  const scamPeople = new Set(scams.map((m) => m.userId)).size;
  const scamShare = sample.length ? scams.length / sample.length : 0;
  if (sample.length >= 10 && scamShare >= 0.4 && (f.type === 'channel' || scamPeople >= 2 || scams.length >= 10)) {
    bad.push(`${pct(scamShare)} of its latest messages sell, solicit or push airdrops ("DM me", wallet links, signals)`);
  }
  if (bad.length) return { ...base, verdict: 'scam', score: 0 };

  if (!seen || !seen.readable) {
    bad.push(seen?.joinRequest ? 'not readable from outside, and joining needs an admin to approve' : 'not readable from outside: only members see what is said');
    return { ...base, verdict: 'closed', score: 0 };
  }

  // What it is about, and how alive.
  const humans = sample.length;
  const people = new Set(sample.map((m) => m.userId)).size;
  base.speakers = f.type === 'group' ? people : null;
  const titleHit = about(`${f.title} ${f.username ?? ''} ${seen.about}`, topic) ? 1 : 0;
  const share = humans ? sample.filter((m) => about(m.text, topic)).length / humans : 0;
  const relevance = humans >= 5 ? 0.35 * titleHit + 0.65 * share : titleHit;
  const d = denoise([...sample].sort((a, b) => a.date - b.date || a.messageId - b.messageId));
  const removed = Object.values(d.removed).reduce((a, b) => a + b, 0);
  // Too few people's messages to say anything about noise: count it as all noise.
  const noise = humans >= 10 ? removed / humans : 1;
  const perDay = seen.perDay ?? 0;
  const silentDays = seen.newestAt ? (now - seen.newestAt) / 86_400 : Infinity;
  const fresh = silentDays <= 1 ? 1 : silentDays <= 7 ? 0.4 : 0;
  const size = clamp(Math.log10(1 + (base.members ?? 0)) / 5);

  if (share >= 0.3) good.push(`${pct(share)} of the latest messages are about ${topic.id === 'crypto' ? 'crypto and markets' : topic.label}`);
  else if (humans >= 10 && share < 0.1) bad.push(`little of what is said is about ${topic.id === 'crypto' ? 'crypto' : topic.label} (${pct(share)})`);

  let score: number;
  if (/(not active|inactive|no longer|deprecated|abandoned|moved to|closed|已停用|停止运营|已关闭|已迁移|搬家)/i.test(`${f.title} ${seen.about}`)) bad.push('its own title or description says it is no longer active');
  if (f.type === 'group') {
    const activity = clamp(Math.log10(1 + perDay) / Math.log10(501));
    const speakers = clamp(people / 25);
    score = 30 * relevance + 20 * activity + 20 * speakers + 15 * (1 - noise) + 10 * size + 5 * fresh;
    if (perDay >= 20 && people >= 10) good.push(`${n(perDay)} messages a day; ${people} people in the last ${humans} messages`);
    if (seen.sampled >= 20 && humans < 10) bad.push(`hardly anyone writes: ${humans} of its last ${seen.sampled} messages are from people`);
    if (perDay >= 200 && people <= 5 && humans >= 10) bad.push(`${n(Math.round(perDay))} messages a day from ${people} accounts: bots or spam, not a conversation`);
    if ((base.members ?? 0) >= 3000 && perDay < 2) bad.push(`${n(base.members ?? 0)} members but ${perDay < 1 ? 'hardly a message' : `${perDay} messages`} a day: members bought, or abandoned`);
    const top = Math.max(0, ...[...new Set(sample.map((m) => m.userId))].map((id) => sample.filter((m) => m.userId === id).length));
    if (humans >= 20 && top / humans >= 0.6) bad.push(`one account writes ${pct(top / humans)} of what is said`);
    if (seen.sampled >= 20 && seen.botMessages / seen.sampled >= 0.5) bad.push(`bots write ${pct(seen.botMessages / seen.sampled)} of its messages`);
  } else {
    const activity = clamp(Math.log10(1 + perDay) / Math.log10(31));
    score = 35 * relevance + 25 * activity + 15 * (1 - noise) + 15 * size + 10 * fresh;
    if (perDay >= 1) good.push(`${perDay >= 10 ? n(Math.round(perDay)) : perDay.toFixed(1)} posts a day`);
    if ((base.members ?? 0) >= 20_000 && perDay < 0.2) bad.push(`${n(base.members ?? 0)} subscribers but it hardly posts`);
  }
  if (humans >= 10 && noise <= 0.2) good.push(`little noise (${pct(noise)} stickers, chatter or spam)`);
  if (humans >= 10 && noise >= 0.5) bad.push(`mostly noise (${pct(noise)} stickers, chatter or spam)`);
  if (scamShare >= 0.15) bad.push(`${pct(scamShare)} of the latest messages sell or solicit`);
  if (silentDays > 7) bad.push(seen.newestAt ? `silent for ${Math.round(silentDays)} days` : 'no messages to see');

  if (f.verified) score += 5;
  if (isOfficial) score += 5;
  score += Math.min(10, 3 * f.mentions);
  score -= 15 * bad.length;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict: Verdict = score >= 60 && bad.length === 0 ? 'good' : score >= 35 ? 'ok' : 'low';
  return { ...base, verdict, score };
}

/** Which of what was found to look at first: on-topic names, big, verified, linked by your groups; flagged ones need no look. */
export function priority(f: Found, topic: Topic): number {
  const name = `${f.title} ${f.username ?? ''}`;
  return (about(name, topic) ? 40 : 0) + Math.min(30, 6 * Math.log10(1 + (f.members ?? 0))) + (f.verified ? 15 : 0) + 8 * Math.min(3, f.mentions) + (f.type === 'group' ? 5 : 0);
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
