// Short-term high-frequency terms: the words and phrases a group suddenly says far more often than
// it did over the day before. Nobody has to name them in advance: every message is cut into terms
// (Latin words and $tickers; Chinese runs as 2–4 character n-grams, since Chinese has no spaces),
// and a term stands out when the last window holds many more messages with it, from several
// people, than its rate in the baseline would give. Pure functions; the service and the MCP server
// both call them on what is stored.

import { denoise } from './denoise.ts';
import { COMMON_EN, COMMON_ZH, UPPER_STOP } from './news-words.ts';
import type { StoredMessage } from './store.ts';

const HAN = /\p{Script=Han}+/gu;
const LATIN = /\$?[a-z][a-z0-9]{1,19}/g;
// Chat filler the news lists do not have: laughter, greetings, pronouns, "what", "this", "can".
const CHAT_ZH = new Set(
  `早上好 早安 午安 晚安 晚上好 下午好 中午好 上班 下班 吃饭 睡觉 加油 努力 辛苦 周末 哈哈 哈哈哈 呵呵 嘿嘿 嗯嗯 好的 好吧 谢谢 早上 晚上 中午 下午 上午 早安 晚安 老师 兄弟 朋友 群里 有人 别人 东西 时候 这里 那里 哪里 怎样 怎么样 多少 不要 不会 不能 不用 不知 不行 不了 不好 不到 一点 一样 一起 一直 有点 还有 没事 没了 是不是 有没有 能不能 要不要 会不会 好像 可能 应该 肯定 确实 估计 大概 直接 赶紧 马上 刚才 刚刚 以前 之前 最近 后面 前面 上面 下面 出来 进去 起来 下去 过来 回来 一下 一次 一天 两天 几天 每天 天天 为啥 干嘛 咋办 咋样 这种 那种 这些 那些 我的 你的 他的 我也 你也 他也 也是 都是 就是 还是 不是 就行 就好 了吧 了啊 了吗 的话 的人 的时候 什么时候`
    .split(/\s+/)
    .filter(Boolean),
);
const CHAT_EN = new Set('gm gn lol lmao haha hahaha yes yeah yep nope okay thanks thank pls please bro guys sir hello hey hii wow omg wtf idk imo btw ser fren'.split(' '));

/** The distinct terms of one message: lowercase Latin words and $tickers, and the Chinese n-grams of 2–4 characters. */
export function termsOf(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  for (const m of lower.matchAll(LATIN)) {
    const w = m[0].startsWith('$') ? m[0].slice(1) : m[0];
    if (w.length < 2 || COMMON_EN.has(w) || CHAT_EN.has(w) || UPPER_STOP.has(w.toUpperCase())) continue;
    out.add(w);
  }
  for (const m of text.matchAll(HAN)) {
    const run = [...m[0]];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n).join('');
        if (COMMON_ZH.has(g) || CHAT_ZH.has(g)) continue;
        // An n-gram that starts on a particle, or ends on one that closes nothing, is a fragment
        // ("的价", "了吗", "都是"); one ending on 了 can be a phrase ("提现不了", "跑路了").
        if (/^[的了吗呢吧啊呀么着过就都也还又在是有和与]|[的吗呢吧啊呀么着过就都也还又在是有和与]$/u.test(g)) continue;
        out.add(g);
      }
    }
  }
  return out;
}

export interface TermBurst {
  /** The phrase as the group writes it ("币安提现不了", "ZEC 要起飞"): its pieces joined back from a message that has them all. */
  term: string;
  /** Its strongest piece (lower case), and every piece it was made of: a later check names the same burst by any of them. */
  key: string;
  parts: string[];
  /** Messages with the term in the window, and how many people wrote them. */
  count: number;
  people: number;
  /** What the baseline rate gives for a window this long. */
  expected: number;
  /** count over expected, both smoothed by one. */
  ratio: number;
  firstAt: number;
  /** Up to five of the window's messages with the term, earliest first. */
  ids: number[];
}

export interface BurstOptions {
  /** The window: [now - windowS, now]. */
  windowS: number;
  /** The baseline: the `baselineS` before the window. */
  baselineS: number;
  /**
   * The same window on earlier days, one list of messages per day (only days the group was already
   * read). A term said every morning ("早上好") is then usual at that hour, not a burst.
   */
  sameHour?: StoredMessage[][];
  minCount: number;
  minPeople: number;
  minRatio: number;
  limit: number;
}

export const BURST_DEFAULTS: BurstOptions = { windowS: 3600, baselineS: 86_400, minCount: 5, minPeople: 3, minRatio: 4, limit: 20 };

/** What the service raises as an alert (and wakes Claude for): stronger than what the tool lists. */
export const ALERT_BURST: Partial<BurstOptions> = { windowS: 1800, minCount: 8, minPeople: 5, minRatio: 6, limit: 5 };

/**
 * The terms of one group whose window is far above their baseline. `messages` must cover the
 * window and the baseline (oldest first is not required). Noise (stickers, one-word chatter, bot
 * commands, scams) is left out first; repeats stay, counted once per person.
 */
export function bursts(messages: StoredMessage[], now: number, o: Partial<BurstOptions> = {}): TermBurst[] {
  const opt = { ...BURST_DEFAULTS, ...o };
  const start = now - opt.windowS;
  const base0 = start - opt.baselineS;
  const kept = messages.filter((m) => m.date >= base0 && m.date <= now);
  const noise = denoise(kept.filter((m) => m.date >= start)).noise;
  const win = new Map<string, { count: number; people: Set<number>; firstAt: number; ids: number[] }>();
  const base = new Map<string, number>();
  for (const m of kept) {
    const terms = termsOf(m.text);
    if (terms.size === 0) continue;
    if (m.date >= start) {
      const kind = noise.get(m.messageId);
      if (kind && kind !== 'repeat') continue;
      for (const t of terms) {
        let w = win.get(t);
        if (!w) win.set(t, (w = { count: 0, people: new Set(), firstAt: m.date, ids: [] }));
        w.count++;
        w.people.add(m.userId);
        if (m.date < w.firstAt) w.firstAt = m.date;
        w.ids.push(m.messageId);
      }
    } else {
      for (const t of terms) base.set(t, (base.get(t) ?? 0) + 1);
    }
  }
  // Messages with each term in the same window on earlier days, averaged over those days.
  const daily = new Map<string, number>();
  const days = opt.sameHour?.length ?? 0;
  for (const day of opt.sameHour ?? []) for (const m of day) for (const t of termsOf(m.text)) daily.set(t, (daily.get(t) ?? 0) + 1 / days);
  type Candidate = { term: string; count: number; people: number; expected: number; ratio: number; firstAt: number; ids: Set<number> };
  const candidates: Candidate[] = [];
  for (const [term, w] of win) {
    if (w.count < opt.minCount || w.people.size < opt.minPeople) continue;
    const expected = Math.max(((base.get(term) ?? 0) * opt.windowS) / opt.baselineS, daily.get(term) ?? 0);
    const ratio = (w.count + 1) / (expected + 1);
    if (ratio < opt.minRatio) continue;
    candidates.push({ term, count: w.count, people: w.people.size, expected, ratio, firstAt: w.firstAt, ids: new Set(w.ids) });
  }
  const texts = new Map(kept.filter((m) => m.date >= start).map((m) => [m.messageId, m.text]));
  return phrases(candidates, texts)
    .sort((a, b) => b.people - a.people || b.ratio - a.ratio || b.count - a.count)
    .slice(0, opt.limit);
}

/**
 * Pieces said in nearly the same messages are one thing said: "币安提现", "安提现不", "提现不了"
 * and "卡了" all come from "币安提现不了，卡了…". They are grouped, and shown as the stretch of a
 * message that holds them all (at most 16 characters), counted by their strongest piece.
 */
function phrases(candidates: { term: string; count: number; people: number; expected: number; ratio: number; firstAt: number; ids: Set<number> }[], texts: Map<number, string>): TermBurst[] {
  const sorted = [...candidates].sort((a, b) => b.count - a.count || [...b.term].length - [...a.term].length);
  const groups: { members: typeof candidates; ids: Set<number> }[] = [];
  for (const c of sorted) {
    const g = groups.find((x) => {
      let shared = 0;
      for (const id of c.ids) if (x.ids.has(id)) shared++;
      return shared >= 0.8 * Math.min(c.ids.size, x.ids.size);
    });
    if (g) {
      g.members.push(c);
      for (const id of c.ids) g.ids.add(id);
    } else groups.push({ members: [c], ids: new Set(c.ids) });
  }
  return groups.map(({ members }) => {
    const top = Math.max(...members.map((m) => m.count));
    // The longest strong piece; a ticker before Chinese of the same length ("zec" over "要起飞").
    const latin = (t: string) => (/^[a-z0-9]+$/.test(t) ? 1 : 0);
    const lead = members.filter((m) => m.count >= 0.8 * top).sort((a, b) => [...b.term].length - [...a.term].length || latin(b.term) - latin(a.term) || b.count - a.count)[0];
    // The message holding the most pieces, and the stretch of it they cover.
    let best = { text: '', n: -1 };
    for (const id of lead.ids) {
      const t = texts.get(id) ?? '';
      const n = members.filter((m) => t.toLowerCase().includes(m.term)).length;
      if (n > best.n) best = { text: t, n };
    }
    const lower = best.text.toLowerCase();
    const spans = members.map((m) => lower.indexOf(m.term)).map((at, i) => [at, at + members[i].term.length]).filter(([at]) => at >= 0);
    const from = Math.min(...spans.map(([a]) => a));
    const to = Math.max(...spans.map(([, b]) => b));
    const phrase = spans.length && to - from <= 16 ? best.text.slice(from, to).trim() : lead.term;
    return { term: phrase || lead.term, key: lead.term, parts: members.map((m) => m.term), count: lead.count, people: lead.people, expected: lead.expected, ratio: lead.ratio, firstAt: Math.min(...members.map((m) => m.firstAt)), ids: [...lead.ids].sort((a, b) => a - b).slice(0, 5) };
  });
}
