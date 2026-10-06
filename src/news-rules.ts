// The news radar's rules: keywords of the day from first-tier sources (Bloomberg, The New York
// Times, a16z, Y Combinator, the crypto wires, the news channels among the sources), and where
// each one turns up in the Telegram groups. Pure code (no I/O), so the tests can pin it down; the
// service (news.ts) fetches, stores and alerts.
//
// The pipeline:
//  1. A headline becomes terms: tickers, names, and the aliases the groups use for them (大饼 for
//     Bitcoin, 鲍威尔 for Powell; news-words.ts).
//  2. Items from different sources that share specific terms are one topic ("Zcash · ETF ·
//     Winklevoss" from The Block, Cointelegraph and Odaily). Topics are the keywords of the day,
//     ranked by how many first-tier sources carry them.
//  3. A group message matches a topic when it names enough of it. A term counts by how unusual
//     it is FOR THAT GROUP: "BTC" in a Binance group says nothing, "Zcash" does.
//  4. Attention: a group reacting to the news (several people within half an hour), or talking
//     about it before the first report.

import { COMMON_EN, COMMON_ZH, CONCEPTS, LEAD_INS, SPONSORED, TRAILERS, UPPER_STOP } from './news-words.ts';

// ── feeds ──────────────────────────────────────────────────────────────────

export interface FeedEntry {
  guid: string;
  title: string;
  link: string | null;
  summary: string;
  /** Unix seconds; null when the feed gives no usable date. */
  publishedAt: number | null;
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·', bull: '•', trade: '™', reg: '®', copy: '©', euro: '€', pound: '£', yen: '¥',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Text of a feed field: CDATA unwrapped, entities decoded, tags removed (twice: feeds double-encode). */
export function textOf(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const once = decodeEntities(unwrapped).replace(/<[^>]*>/g, ' ');
  return decodeEntities(once).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function field(block: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = re.exec(block);
    if (m && m[1].trim()) return m[1];
  }
  return null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const href = (attrs: string) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
  const alt = links.find((a) => /\brel\s*=\s*["']alternate["']/i.test(a)) ?? links.find((a) => !/\brel\s*=/i.test(a));
  return alt ? href(alt) : null;
}

/** RSS 2.0 or Atom. Malformed parts are skipped, never thrown: a feed is someone else's text. */
export function parseFeed(xml: string): { title: string; entries: FeedEntry[] } {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const head = xml.slice(0, Math.max(0, xml.search(atom ? /<entry\b/i : /<item\b/i)) || xml.length);
  const entries: FeedEntry[] = [];
  for (const b of blocks) {
    const title = textOf(field(b, ['title']) ?? '');
    if (!title) continue;
    let link = atom ? atomLink(b) : textOf(field(b, ['link']) ?? '') || null;
    if (link && !/^https?:\/\//i.test(link)) link = null;
    const guid = textOf(field(b, ['guid', 'id']) ?? '') || link || title;
    const date = textOf(field(b, ['pubDate', 'published', 'updated', 'dc:date', 'a10:updated']) ?? '');
    const ms = date ? Date.parse(date) : Number.NaN;
    const rawSummary = field(b, ['description', 'summary', 'content:encoded', 'content']) ?? '';
    let summary = textOf(rawSummary.slice(0, 20_000)).slice(0, 600);
    if (/^comments$/i.test(summary)) summary = ''; // Hacker News: the summary is a link to the comments
    entries.push({ guid: guid.slice(0, 500), title: title.slice(0, 400), link, summary, publishedAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null });
  }
  return { title: textOf(field(head, ['title']) ?? ''), entries };
}

// ── headlines ──────────────────────────────────────────────────────────────

const MEDIA_TAG = /\[(?:photo|video|gif|sticker[^\]]*|voice[^\]]*|audio[^\]]*|document[^\]]*|poll[^\]]*|video note|location|contact|forwarded(?: from [^\]]*)?)\]/gi;
const LINK_RE = /\bhttps?:\/\/\S+|\bt\.me\/\S+/gi;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu;

/** A headline without wire tags ("JUST IN:"), links, handles, emoji or trailers. */
export function cleanHeadline(text: string): string {
  let t = text.normalize('NFKC').replace(MEDIA_TAG, ' ').replace(LINK_RE, ' ');
  for (const re of TRAILERS) t = t.replace(re, ' ');
  for (let i = 0; i < 3; i++) for (const re of LEAD_INS) t = t.replace(re, '');
  return t.replace(EMOJI, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** A channel post as a news item: its first real line is the headline, the rest the summary. */
export function postAsNews(text: string): { title: string; summary: string } | null {
  if (SPONSORED.test(text)) return null;
  const lines = cleanHeadline(text).split('\n').map((l) => l.trim()).filter((l) => l.length > 1);
  if (lines.length === 0) return null;
  const [title, ...rest] = lines;
  if (title.replace(/[\s\p{P}\p{S}]/gu, '').length < 8) return null; // "[photo]" alone, a lone emoji
  return { title: title.slice(0, 300), summary: rest.join(' ').slice(0, 500) };
}

// ── terms ──────────────────────────────────────────────────────────────────

/** strong: a ticker, a name, a known alias. medium: a capitalized word, a broad topic. weak: a Chinese word. */
export type TermClass = 'strong' | 'medium' | 'weak';

export interface Term {
  key: string;
  label: string;
  cls: TermClass;
  /** Matched in a message only in exactly this form or as a $cashtag ("WINK", "NEAR"): its lowercase is an ordinary word. */
  strict?: boolean;
}

const RANK: Record<TermClass, number> = { strong: 3, medium: 2, weak: 1 };
export const CLASS_WEIGHT: Record<TermClass, number> = { strong: 2, medium: 1, weak: 0.5 };
const DEMOTE: Record<TermClass, TermClass | null> = { strong: 'medium', medium: 'weak', weak: null };

// Concepts that count as medium terms: broad topics and institutions, and names so common (the
// majors, the megacaps, the indexes, Trump and Musk) that one alone does not say which story it is.
const BROAD = new Set([
  'etf', 'ipo', 'ai', 'stablecoin', 'rwa', 'hack', 'inflation', 'cpi', 'ppi', 'pce', 'payrolls', 'recession', 'shutdown', 'gdp', 'oil', 'gold', 'silver', 'tariffs', 'ratecut', 'ratehike',
  'iran', 'israel', 'russia', 'ukraine', 'venezuela', 'taiwan', 'northkorea', 'fed', 'sec', 'cftc', 'treasury', 'whitehouse', 'congress', 'ecb', 'boj', 'pboc', 'imf',
  'btc', 'eth', 'bnb', 'sol', 'xrp', 'doge', 'usdt', 'usdc', 'binance',
  'google', 'apple', 'meta', 'amazon', 'microsoft', 'nvidia', 'tesla', 'openai', 'nasdaq', 'sp500', 'dow', 'nyse', 'p:trump', 'p:musk', 'p:xi', 'p:putin',
]);
/** Too common to tie two stories together: Bitcoin news and Tether news are not one topic. */
const NON_LINKING = new Set(['btc', 'eth', 'bnb', 'sol', 'xrp', 'usdt', 'usdc', 'binance', 'p:trump', 'ai', 'etf', 'stablecoin', 'nasdaq', 'sp500']);
/** Products everyone names: medium, like the megacaps. */
const COMMON_PRODUCTS = new Set(['iphone', 'ipad', 'android', 'chrome', 'youtube', 'twitter', 'instagram', 'whatsapp', 'telegram', 'wechat', 'windows', 'linux', 'github', 'gmail', 'macos', 'ios']);
const ORG_SUFFIX = new Set(['fund', 'capital', 'group', 'bank', 'labs', 'ventures', 'partners', 'holdings', 'foundation', 'protocol', 'network', 'exchange', 'research', 'securities', 'asset', 'management', 'technologies', 'inc', 'corp', 'markets', 'digital', 'finance', 'trust', 'investments', 'advisors', 'institute', 'university', 'association', 'council', 'commission', 'agency', 'ministry', 'court']);

const HAS_CJK = /\p{Script=Han}/u;
const CJK_ONLY = /^\p{Script=Han}+$/u;

export interface ConceptIndex {
  /** Lowercase loose alias (one to three words) → concept key. */
  loose: Map<string, string>;
  /** Exact strict form → concept key. */
  strict: Map<string, string>;
  /** CJK alias → concept key, longest first in `cjkRe`. */
  cjk: Map<string, string>;
  cjkRe: RegExp | null;
  label: Map<string, string>;
}

function buildConceptIndex(): ConceptIndex {
  const idx: ConceptIndex = { loose: new Map(), strict: new Map(), cjk: new Map(), cjkRe: null, label: new Map() };
  for (const c of CONCEPTS) {
    idx.label.set(c.key, c.label);
    for (const a of c.loose) idx.loose.set(a, c.key);
    for (const a of c.strict) idx.strict.set(a, c.key);
    for (const a of c.cjk) idx.cjk.set(a, c.key);
  }
  idx.cjkRe = cjkRegex([...idx.cjk.keys()]);
  return idx;
}

function cjkRegex(forms: string[]): RegExp | null {
  if (forms.length === 0) return null;
  const esc = forms.sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(esc.join('|'), 'g');
}

export const CONCEPT_INDEX = buildConceptIndex();

interface Tok {
  raw: string;
  lower: string;
  /** Joined to the previous token by spaces only (so they can form a name or a phrase). */
  joined: boolean;
  start: number;
  end: number;
}

// Latin-script words (accents included, so "opérate" is one word, not "op" + "rate"), digits, and $cashtags.
const TOKEN = /\$?[\p{Script=Latin}0-9][\p{Script=Latin}0-9.&'’\-]*[\p{Script=Latin}0-9]|\$?[\p{Script=Latin}0-9]/gu;

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let prevEnd = -1;
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0].replace(/['’]s$/i, '').replace(/[.'’\-]+$/, '');
    if (!raw) continue;
    const start = m.index ?? 0;
    if (/^[\d.,%-]+$/.test(raw.replace(/^\$/, ''))) {
      out.push({ raw, lower: raw.toLowerCase(), joined: false, start, end: start + raw.length }); // numbers break names apart
      prevEnd = start + m[0].length;
      continue;
    }
    const between = prevEnd < 0 ? '' : text.slice(prevEnd, start);
    out.push({ raw, lower: raw.toLowerCase(), joined: prevEnd >= 0 && /^[ \t]+$/.test(between), start, end: start + raw.length });
    prevEnd = start + m[0].length;
  }
  return out;
}

/** Concept keys named in a text, by alias (both the loose and the strict forms, and CJK). */
function conceptsIn(text: string, toks: Tok[], into: (key: string) => void): void {
  const idx = CONCEPT_INDEX;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const bare = t.lower.replace(/^\$/, '');
    const hit = idx.loose.get(bare) ?? (t.raw.startsWith('$') ? idx.strict.get(t.raw.slice(1).toUpperCase()) : undefined) ?? idx.strict.get(t.raw.replace(/^\$/, ''));
    if (hit) into(hit);
    if (bare.includes('-')) for (const part of bare.split('-')) idx.loose.has(part) && into(idx.loose.get(part)!);
    for (let n = 2; n <= 3 && i + n <= toks.length; n++) {
      const run = toks.slice(i, i + n);
      if (run.slice(1).some((x) => !x.joined)) break;
      const k = idx.loose.get(run.map((x) => x.lower).join(' '));
      if (k) into(k);
    }
  }
  if (idx.cjkRe && HAS_CJK.test(text)) for (const m of text.matchAll(idx.cjkRe)) into(idx.cjk.get(m[0])!);
}

let segmenter: Intl.Segmenter | null = null;

/** A Chinese word that is (or contains) a known alias: the concept already stands for it. */
function aliasInside(w: string): boolean {
  if (CONCEPT_INDEX.cjk.has(w)) return true;
  for (const a of CONCEPT_INDEX.cjk.keys()) if (a.length >= 2 && w.includes(a)) return true;
  return false;
}

/** Chinese words worth matching: the segmenter's words of two or more characters, and three- or four-character runs it split into single characters (names: 布伦特, 鲍威尔). */
function cjkWords(text: string): string[] {
  segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
  const words: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const w = run.join('');
    if (w.length >= 3 && w.length <= 4 && !COMMON_ZH.has(w) && !aliasInside(w)) words.push(w);
    run = [];
  };
  for (const s of segmenter.segment(text)) {
    const w = s.segment;
    if (!s.isWordLike || !CJK_ONLY.test(w)) {
      flush();
      continue;
    }
    if (w.length === 1) {
      run.push(w);
      continue;
    }
    flush();
    if (!COMMON_ZH.has(w) && !aliasInside(w)) words.push(w);
  }
  flush();
  return words;
}

/**
 * The terms of one news item. The title counts in full; the summary one class lower, and in a
 * Title Case headline ("Bitcoin Bulls Descend on Singapore") a capitalized word counts only if the
 * summary also writes it with a capital (so "Descend" is not taken for a name).
 */
export function extractTerms(title: string, summary = ''): Term[] {
  const out = new Map<string, Term>();
  const add = (key: string, label: string, cls: TermClass | null, strict = false) => {
    if (!cls || !key || key.length < 2) return;
    const prev = out.get(key);
    if (!prev) out.set(key, { key, label, cls, ...(strict ? { strict } : {}) });
    else if (RANK[cls] > RANK[prev.cls]) out.set(key, { ...prev, cls });
  };
  // Capitalized mid-sentence in the summary (not after a full stop): a name, not a Title Case word.
  const capsInSummary = new Set(tokens(summary).filter((t) => t.joined && /^[A-Z][a-z]/.test(t.raw)).map((t) => t.lower));
  const scan = (raw: string, part: 'title' | 'summary') => {
    const text = cleanHeadline(raw);
    if (!text) return;
    const demote = (c: TermClass): TermClass | null => (part === 'summary' ? DEMOTE[c] : c);
    const toks = tokens(text);
    // Known names, by any alias.
    conceptsIn(text, toks, (key) => add(key, CONCEPT_INDEX.label.get(key) ?? key, demote(BROAD.has(key) ? 'medium' : 'strong')));
    const words = toks.filter((t) => /[A-Za-z]/.test(t.raw));
    const letters = words.filter((t) => t.raw.replace(/^\$/, '').length >= 2);
    const shouting = letters.length >= 5 && letters.filter((t) => t.raw === t.raw.toUpperCase()).length / letters.length > 0.6;
    const titleCase = part === 'title' && letters.length >= 4 && letters.filter((t) => t.raw.length >= 4 && /^[A-Z]/.test(t.raw)).length / Math.max(1, letters.filter((t) => t.raw.length >= 4).length) > 0.6;
    const known = (bare: string) => CONCEPT_INDEX.loose.has(bare.toLowerCase()) || CONCEPT_INDEX.strict.has(bare) || CONCEPT_INDEX.strict.has(bare.toUpperCase());
    let run: Tok[] = [];
    // In a Title Case headline every word has a capital, so a word is a name only if the summary
    // also capitalizes it mid-sentence; the others are dropped from the run (or kept weak alone).
    const confirmed = (t: Tok) => !titleCase || capsInSummary.has(t.lower) || ORG_SUFFIX.has(t.lower);
    const flush = () => {
      const kept = titleCase ? run.filter(confirmed) : run;
      const named = kept.filter((t) => !ORG_SUFFIX.has(t.lower));
      if (kept.length >= 2 && named.length >= 1 && kept.length === run.length) {
        add(kept.map((t) => t.lower).join(' '), kept.map((t) => t.raw).join(' '), demote('strong'));
        for (const t of named) add(t.lower, t.raw, demote('medium'));
      } else if (named.length >= 1) {
        for (const t of named) add(t.lower, t.raw, demote('medium'));
      } else if (run.length >= 1 && kept.length === 0) {
        for (const t of run) if (!ORG_SUFFIX.has(t.lower)) add(t.lower, t.raw, demote('weak'));
      }
      run = [];
    };
    for (const t of toks) {
      const bare = t.raw.replace(/^\$/, '');
      const lower = bare.toLowerCase();
      if (!/[A-Za-z]/.test(bare) || known(bare) || bare.split('-').some((part) => known(part))) {
        flush();
        continue;
      }
      // $TICKER
      if (t.raw.startsWith('$') && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(bare)) {
        flush();
        add(lower, bare.toUpperCase(), demote('strong'), COMMON_EN.has(lower));
        continue;
      }
      // ALLCAPS: a ticker or an acronym (WINK, BCH, ANVL)
      if (!shouting && /^[A-Z][A-Z0-9]{1,6}$/.test(bare) && /[A-Z].*[A-Z]/.test(bare)) {
        flush();
        if (!UPPER_STOP.has(bare)) add(lower, bare, demote('strong'), COMMON_EN.has(lower));
        continue;
      }
      // Mixed case or letters with digits: SpaceX, zkSync, GPT-5, S-1
      if (/[a-z][A-Z]|^[a-z]+[A-Z]/.test(bare) || (/^[A-Za-z]{2,}[-]?\d/.test(bare) && bare.length >= 3) || /^[A-Za-z]+\d+[A-Za-z]+$/.test(bare)) {
        flush();
        if (!COMMON_EN.has(lower)) add(lower, bare, demote(COMMON_PRODUCTS.has(lower) ? 'medium' : 'strong'));
        continue;
      }
      // Capitalized words: names, alone or in a run (Joseph Chee, Founders Fund)
      const parts = bare.split('-');
      const cap = /^[A-Z][a-z'’]+$/.test(parts[0]) && parts[0].length >= 3;
      if (cap && !COMMON_EN.has(parts[0].toLowerCase()) && !shouting) {
        if (run.length && !t.joined) flush();
        run.push({ ...t, raw: parts[0], lower: parts[0].toLowerCase() });
        if (parts.length > 1) flush(); // "Thiel-backed": the name ends at the hyphen
        continue;
      }
      if (cap && run.length && t.joined && ORG_SUFFIX.has(parts[0].toLowerCase())) {
        run.push({ ...t, raw: parts[0], lower: parts[0].toLowerCase(), joined: true }); // "Founders Fund"
        continue;
      }
      flush();
    }
    flush();
    // Chinese words (weak: they only support a match).
    if (HAS_CJK.test(text)) for (const w of cjkWords(text)) add(w, w, demote('weak'));
  };
  scan(title, 'title');
  if (summary) scan(summary, 'summary');
  return [...out.values()].sort((a, b) => RANK[b.cls] - RANK[a.cls]);
}

// ── matching a message ─────────────────────────────────────────────────────

/** What a group message is matched against: the aliases, plus the terms of the day's news. */
export interface Lexicon {
  loose: Map<string, string>;
  strict: Map<string, string>;
  cjk: Map<string, string>;
  cjkRe: RegExp | null;
}

export function buildLexicon(terms: Iterable<Term>): Lexicon {
  const lex: Lexicon = { loose: new Map(CONCEPT_INDEX.loose), strict: new Map(CONCEPT_INDEX.strict), cjk: new Map(CONCEPT_INDEX.cjk), cjkRe: null };
  for (const t of terms) {
    if (CONCEPT_INDEX.label.has(t.key)) continue; // a known name: matched by its aliases, never by its key
    if (CJK_ONLY.test(t.key)) lex.cjk.set(t.key, t.key);
    else if (t.strict) lex.strict.set(t.label, t.key);
    else if (!lex.loose.has(t.key)) lex.loose.set(t.key, t.key);
  }
  lex.cjkRe = cjkRegex([...lex.cjk.keys()]);
  return lex;
}

/** The keys (concepts and news terms) a message names. */
export function keysIn(text: string, lex: Lexicon): Set<string> {
  const found = new Set<string>();
  const t = text.normalize('NFKC');
  const toks = tokens(t);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const bare = tok.lower.replace(/^\$/, '');
    const cashtag = tok.raw.startsWith('$');
    const loose = lex.loose.get(bare);
    if (loose) found.add(loose);
    const strict = lex.strict.get(tok.raw.replace(/^\$/, '')) ?? (cashtag ? lex.strict.get(bare.toUpperCase()) : undefined);
    if (strict) found.add(strict);
    if (bare.includes('-')) for (const part of bare.split('-')) if (lex.loose.has(part)) found.add(lex.loose.get(part)!);
    for (let n = 2; n <= 3 && i + n <= toks.length; n++) {
      const run = toks.slice(i, i + n);
      if (run.slice(1).some((x) => !x.joined)) break;
      const k = lex.loose.get(run.map((x) => x.lower).join(' '));
      if (k) found.add(k);
    }
  }
  if (lex.cjkRe && HAS_CJK.test(t)) for (const m of t.matchAll(lex.cjkRe)) found.add(lex.cjk.get(m[0])!);
  return found;
}

/** Where in a message the given keys are named ([start, end) offsets, for highlighting). */
export function matchSpans(text: string, lex: Lexicon, keys: Set<string>): [number, number][] {
  const spans: [number, number][] = [];
  const toks = tokens(text);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    const bare = tok.lower.replace(/^\$/, '');
    const k = lex.loose.get(bare) ?? lex.strict.get(tok.raw.replace(/^\$/, '')) ?? (tok.raw.startsWith('$') ? lex.strict.get(bare.toUpperCase()) : undefined);
    if (k && keys.has(k)) spans.push([tok.start, tok.end]);
    for (let n = 2; n <= 3 && i + n <= toks.length; n++) {
      const run = toks.slice(i, i + n);
      if (run.slice(1).some((x) => !x.joined)) break;
      const key = lex.loose.get(run.map((x) => x.lower).join(' '));
      if (key && keys.has(key)) spans.push([run[0].start, run[n - 1].end]);
    }
  }
  if (lex.cjkRe && HAS_CJK.test(text)) for (const m of text.matchAll(lex.cjkRe)) if (keys.has(lex.cjk.get(m[0])!)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const sp of spans) {
    const last = out[out.length - 1];
    if (last && sp[0] < last[1]) last[1] = Math.max(last[1], sp[1]);
    else out.push([sp[0], sp[1]]);
  }
  return out;
}

// ── topics: the keywords of the day ────────────────────────────────────────

export interface NewsItem {
  id: number;
  sourceId: string;
  sourceName: string;
  /** 1 = first tier (Bloomberg, NYT, a16z, YC, the main wires), 2 = the rest. */
  tier: number;
  title: string;
  summary: string;
  link: string | null;
  publishedAt: number;
  seenAt: number;
  /** Came in a source's first fetch: real news, but not breaking when it was seen. */
  backlog: boolean;
  terms?: Term[];
}

export interface TopicTerm extends Term {
  /** Items of the topic that carry it. */
  items: number;
  /** In more than ~6% of all the day's items ("Bitcoin", "Trump"): it does not make a topic. */
  generic: boolean;
}

export interface Topic {
  /** The id of its first item: stable while the topic grows. */
  id: number;
  label: string;
  terms: TopicTerm[];
  items: NewsItem[];
  firstAt: number;
  lastAt: number;
  sources: { id: string; name: string; tier: number; firstAt: number; link: string | null; title: string }[];
  score: number;
}

const TIER_WEIGHT: Record<number, number> = { 1: 1, 2: 0.6 };

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normLink(s: string | null): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return s;
  }
}

/**
 * Groups the window's items into topics and ranks them. Two items are one topic when they share
 * two specific terms, or one specific strong term (a ticker, a name) that few items carry.
 */
export function buildTopics(all: NewsItem[], opts: { now: number; windowS?: number }): Topic[] {
  const from = opts.now - (opts.windowS ?? 86_400);
  const seenLinks = new Set<string>();
  const seenTitles = new Set<string>();
  const items: (NewsItem & { terms: Term[] })[] = [];
  for (const it of [...all].sort((a, b) => a.publishedAt - b.publishedAt || a.id - b.id)) {
    if (it.publishedAt < from || it.publishedAt > opts.now + 600) continue;
    if (SPONSORED.test(`${it.title} ${it.summary}`)) continue;
    const link = normLink(it.link);
    const nt = normTitle(it.title);
    if ((link && seenLinks.has(link)) || seenTitles.has(nt)) continue; // the same article in two sections of one outlet
    if (link) seenLinks.add(link);
    seenTitles.add(nt);
    const terms = it.terms ?? extractTerms(it.title, it.summary);
    if (terms.length === 0) continue;
    items.push({ ...it, terms });
  }
  const df = new Map<string, number>();
  for (const it of items) for (const t of it.terms) df.set(t.key, (df.get(t.key) ?? 0) + 1);
  const genericAt = Math.max(5, items.length * 0.06);
  const generic = (k: string) => (df.get(k) ?? 0) > genericAt;
  const linking = items.map((it) => new Map(it.terms.filter((t) => t.cls !== 'weak' && !generic(t.key) && !NON_LINKING.has(t.key)).map((t) => [t.key, t])));

  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].publishedAt - items[i].publishedAt > 18 * 3600) break;
      let shared = 0;
      let rareStrong = false;
      for (const [k, t] of linking[i]) {
        if (!linking[j].has(k)) continue;
        shared++;
        if (t.cls === 'strong' && linking[j].get(k)!.cls === 'strong' && (df.get(k) ?? 0) <= 4) rareStrong = true;
      }
      if (shared >= 2 || rareStrong) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map<number, (NewsItem & { terms: Term[] })[]>();
  items.forEach((it, i) => {
    const r = find(i);
    clusters.set(r, [...(clusters.get(r) ?? []), it]);
  });

  const topics: Topic[] = [];
  for (const group of clusters.values()) {
    const n = group.length;
    const agg = new Map<string, TopicTerm>();
    for (const it of group) {
      for (const t of it.terms) {
        const prev = agg.get(t.key);
        if (!prev) agg.set(t.key, { ...t, items: 1, generic: generic(t.key) });
        else {
          prev.items++;
          if (RANK[t.cls] > RANK[prev.cls]) prev.cls = t.cls;
        }
      }
    }
    const need = n >= 3 ? Math.ceil(n * 0.34) : 1;
    const terms = [...agg.values()]
      .filter((t) => t.items >= need || (t.cls === 'strong' && (n <= 5 || t.items >= 2)) || (n <= 2 && t.cls !== 'weak') || (t.cls === 'weak' && t.items >= Math.min(2, n)))
      .sort((a, b) => Number(a.generic) - Number(b.generic) || RANK[b.cls] - RANK[a.cls] || b.items - a.items);
    // Nothing nameable (only weak words): no keyword to look for in a group.
    if (!terms.some((t) => t.cls !== 'weak')) continue;
    const named = terms.filter((t) => !t.generic && t.cls !== 'weak');
    // Up to three names, none repeating another ("Jamie Dimon", not also "Jamie").
    const picked: string[] = [];
    const words = (x: string) => x.toLowerCase().split(/\s+/);
    for (const t of named.length ? named : terms) {
      const w = words(t.label);
      if (picked.some((p) => w.every((x) => words(p).includes(x)) || words(p).every((x) => w.includes(x)))) continue;
      picked.push(t.label);
      if (picked.length === 3) break;
    }
    const label = picked.join(' · ');
    const bySource = new Map<string, Topic['sources'][number]>();
    for (const it of group) if (!bySource.has(it.sourceId)) bySource.set(it.sourceId, { id: it.sourceId, name: it.sourceName, tier: it.tier, firstAt: it.publishedAt, link: it.link, title: it.title });
    const sources = [...bySource.values()];
    const firstAt = group[0].publishedAt;
    const lastAt = group[n - 1].publishedAt;
    const weight = sources.reduce((s, x) => s + (TIER_WEIGHT[x.tier] ?? 0.6), 0) + 0.2 * (n - sources.length);
    const agreement = sources.length >= 3 ? 2 : sources.length === 2 ? 1.5 : 1;
    const age = Math.max(0, opts.now - lastAt) / 3600;
    const score = Math.round(weight * agreement * (0.5 + 0.5 * Math.exp(-age / 12)) * 100) / 100;
    topics.push({ id: Math.min(...group.map((g) => g.id)), label, terms, items: group, firstAt, lastAt, sources, score });
  }
  return topics.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
}

// ── how unusual a term is for one group ────────────────────────────────────

export interface Baseline {
  /** Messages naming it in the baseline period (the last week, minus the last 6 hours). */
  count: number;
  /** All messages of the group in that period. */
  total: number;
  days: number;
}

/**
 * 1: unusual for this group (a name it rarely uses); 0.5: it comes up now and then; 0: the group
 * talks about it all the time ("大饼" in a Binance group), so naming it says nothing.
 */
export function rarityFactor(b: Baseline): number {
  if (b.count < 3) return 1;
  const perDay = b.count / Math.max(b.days, 0.5);
  const share = b.total > 0 ? b.count / b.total : 0;
  if ((perDay > 12 && share > 0.002) || share > 0.03) return 0;
  if ((perDay > 4 && share > 0.0007) || share > 0.01) return 0.5;
  return 1;
}

/** A message names a topic when its matched terms, weighted by class and rarity, reach this. */
export const HIT_SCORE = 2;
/** More than 6 hours after the news, one name alone is more likely another story: two terms are needed. */
export const LATE_HIT_SCORE = 3;
export const LATE_S = 6 * 3600;

export function scoreTopic(topic: Topic, keys: Set<string>, factor: (key: string) => number): { score: number; matched: TopicTerm[] } {
  const matched = topic.terms.filter((t) => keys.has(t.key));
  let score = 0;
  for (const t of matched) score += CLASS_WEIGHT[t.cls] * factor(t.key);
  return { score: Math.round(score * 100) / 100, matched };
}

// ── attention ──────────────────────────────────────────────────────────────

export interface Hit {
  chatId: number;
  messageId: number;
  userId: number;
  date: number;
  topicId: number;
  /** The matched terms' labels. */
  terms: string[];
  /** Their keys (for highlighting where the message names them). */
  keys: string[];
  score: number;
  /** Seconds after the topic's first report (negative: before it). */
  lag: number;
}

export type Attention = 'hot' | 'first' | 'echo';

/** Lead time that still counts as the group having it first. */
export const AHEAD_S = 6 * 3600;

/**
 * hot   = after the news: 3+ messages from 2+ people within 30 minutes.
 * first = before the first report: 3+ messages from 2+ people within two hours, in the 6 hours before it.
 * echo  = it came up at all.
 */
export function attention(hits: Hit[]): { level: Attention; burst: Hit[] } | null {
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => a.date - b.date);
  const after = sorted.filter((h) => h.lag >= 0);
  // The most recent burst: the half hour ending at each hit, latest first.
  for (let j = after.length - 1; j >= 0; j--) {
    const win = after.filter((h) => h.date > after[j].date - 1800 && h.date <= after[j].date);
    if (win.length >= 3 && new Set(win.map((h) => h.userId)).size >= 2) return { level: 'hot', burst: win };
  }
  // Before the first report: a cluster (3+ messages from 2+ people within two hours), not the
  // group's everyday mentions spread over the morning.
  const before = sorted.filter((h) => h.lag < 0 && h.lag >= -AHEAD_S);
  for (let j = before.length - 1; j >= 0; j--) {
    const win = before.filter((h) => h.date > before[j].date - 7200 && h.date <= before[j].date);
    if (win.length >= 3 && new Set(win.map((h) => h.userId)).size >= 2) return { level: 'first', burst: win };
  }
  return { level: 'echo', burst: sorted.slice(0, 1) };
}

/**
 * The hits worth showing: everything after the first report, and what came before it only when it
 * was a real discussion (a lead: see attention). One person mentioning OKX in the morning is not
 * the group knowing first.
 */
export function shownHits(hits: Hit[]): Hit[] {
  const before = hits.filter((h) => h.lag < 0);
  if (before.length === 0) return hits;
  const lead = attention(before)?.level === 'first';
  return lead ? hits : hits.filter((h) => h.lag >= 0);
}

/** "+12m", "+2h05m", "38m before". */
export function formatLag(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const span = h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m` : `${s}s`;
  return seconds < 0 ? `${span} before` : `+${span}`;
}
