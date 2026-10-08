// The live view's map: which groups talk about the same things, day by day. A group's topics are
// the terms (src/terms.ts) of what the denoiser keeps of its day, said by at least two people (a
// channel: in at least two posts). Two groups are close when the topics that set them apart from the
// day's other groups are the same: the cosine of their TF-IDF vectors, with that day's groups as the
// documents. A route names the topics it stands for; groups that stay close form a galaxy, named by
// the topics they share. Nothing is invented: no topics in common, no route. Pure functions over
// what is stored.

import { denoise } from './denoise.ts';
import type { StoredMessage } from './store.ts';
import { termsOf } from './terms.ts';
import { lastSlot, localDate } from './transcript.ts';

export interface MapNode {
  chatId: number;
  /** Messages that day. */
  messages: number;
  /** Its own most telling topics that day. */
  topics: string[];
}

export interface MapEdge {
  a: number;
  b: number;
  /** How much the two groups' topics overlap, 0–1 (cosine). */
  overlap: number;
  /** The topics they share, the ones that weigh most first. */
  topics: string[];
}

export interface Galaxy {
  members: number[];
  /** The topics its groups share. */
  topics: string[];
}

export interface DayMap {
  day: string;
  from: number;
  to: number;
  nodes: MapNode[];
  edges: MapEdge[];
  galaxies: Galaxy[];
}

/** Below this, an overlap is chance (one common word between two big groups). */
export const MIN_OVERLAP = 0.02;
/** Groups whose topics overlap at least this much, on average, form a galaxy. */
export const GALAXY_AT = 0.05;

// Talk that says nothing about a topic: what the shared lists (news-words.ts, used by termsOf) do
// not already drop. Chinese chat fillers and fragments, and English words of every subject.
const FILLER = new Set(
  `不知道 来了 你去 多了 很多 我不 个月 国内 学生 一个 这个 那个 什么 怎么 现在 今天 明天 昨天 已经 因为 所以 但是 如果 然后 自己 没有 可以 知道 觉得 感觉
   真的 时候 问题 事情 我们 你们 他们 大家 这么 那么 为什么 是的 对的 不错 厉害 太多 好多 不少 更多 最多 少了 去了 走了 好了 对了 算了 完了 行了 一下 看看
   看到 听说 一直 只是 需要 其实 反正 而且 或者 不过 一般 比较 非常 特别 每次 有时 别的 其他 这边 那边 里面 外面 东西 地方 原因 结果 情况 意思 办法 这样
   那样 几个 有的 有些 一些 咱们 人家 一定 以为 喜欢 不然 为什 是啊 对啊 好啊 没错 怎么了 不用了 不行了 没有了 知道了 可以了 太多了 一样的 一点点 差不多
   这么多 那么多 两个 三个 兄弟们 兄弟 不如 容易 不一 不一样 发现 怎么办 还不 都不 也不 就不 不太 太大 很大 很好 很快 之后 以后 一起 有点 啊啊 哦哦 嗯嗯`
    .split(/\s+/)
    .filter(Boolean),
);
const FILLER_EN = new Set(
  `very don working closing information people time today going know think good really just like get got make made want need still also back even much many
   more most some any every new old first last next same well right left world year years day days week month way thing things lot sure dont cant wont didnt
   doesnt isnt im youre thats theres what when where which who why how this that these those there here then than them they their our your from with into
   about over under after before while because though although only ever never always often sometimes one two three now said says say see look looking`
    .split(/\s+/)
    .filter(Boolean),
);
/** A Chinese n-gram that starts on a personal pronoun, or on 给/那/这/让… before one, is a piece of a sentence ("我买", "你去", "给你", "那我"). */
const PRONOUN_START = /^(?:[我你他她它咱]|[给那这让跟和对被把叫][你我他她])/u;
/** What the reader writes for media ("[sticker 😀]", "[photo]"). */
const PLACEHOLDER = /\[[^\]]{1,40}\]/g;
const HAN_3_4 = /^\p{Script=Han}{3,4}$/u;

/**
 * A group's topics on one day: each term with how many people said it (a channel: in how many
 * posts). Noise is left out first (the denoiser's rules); a piece that (almost) only occurs inside
 * a longer term goes (比特, 特币 → 比特币).
 */
export function topicsOf(messages: StoredMessage[], channel: boolean): Map<string, number> {
  const said = new Map<string, Set<number>>();
  const add = (text: string, who: number) => {
    for (const t of termsOf(text.replace(PLACEHOLDER, ' '))) {
      let s = said.get(t);
      if (!s) said.set(t, (s = new Set()));
      s.add(who);
    }
  };
  const d = denoise(messages);
  // A channel posts alone, and the denoiser joins one author's run of messages into one line: so a
  // channel is read post by post (what the denoiser drops still left out), a group line by line.
  if (channel) for (const m of messages) if (!d.noise.has(m.messageId)) add(m.text, m.messageId);
  if (!channel) for (const l of d.lines) add(l.text, l.userId);
  for (const [t, s] of said) {
    if (!HAN_3_4.test(t)) continue;
    const chars = [...t];
    for (let k = 2; k < chars.length; k++) {
      for (let i = 0; i + k <= chars.length; i++) {
        const piece = chars.slice(i, i + k).join('');
        const ps = said.get(piece);
        if (ps && s.size >= ps.size * 0.9) said.delete(piece);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [t, s] of said) {
    if (s.size < 2 || FILLER.has(t) || FILLER_EN.has(t)) continue;
    if (/^\p{Script=Han}/u.test(t) && PRONOUN_START.test(t)) continue;
    out.set(t, s.size);
  }
  return out;
}

/** The day's map: every group's topics, the overlaps between them, and the galaxies they form. */
export function dayMap(input: { chatId: number; channel: boolean; messages: StoredMessage[] }[], day: string, from: number, to: number): DayMap {
  const topics = new Map<number, Map<string, number>>();
  for (const x of input) if (x.messages.length) topics.set(x.chatId, topicsOf(x.messages, x.channel));
  const ids = [...topics.keys()];
  const df = new Map<string, number>();
  for (const id of ids) for (const t of topics.get(id)!.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const vec = new Map<number, Map<string, number>>();
  const norm = new Map<number, number>();
  for (const id of ids) {
    const v = new Map<string, number>();
    let sq = 0;
    for (const [t, n] of topics.get(id)!) {
      const w = Math.log(1 + n) * Math.log(1 + ids.length / df.get(t)!);
      v.set(t, w);
      sq += w * w;
    }
    vec.set(id, v);
    norm.set(id, Math.sqrt(sq));
  }
  const top = (weights: Iterable<[string, number]>, k: number) => pick([...weights].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([t]) => t), k);
  const nodes: MapNode[] = input.map((x) => ({ chatId: x.chatId, messages: x.messages.length, topics: vec.has(x.chatId) ? top(vec.get(x.chatId)!, 6) : [] }));
  const edges: MapEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = vec.get(ids[i])!;
      const b = vec.get(ids[j])!;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let dot = 0;
      const shared: [string, number][] = [];
      for (const [t, x] of small) {
        const y = big.get(t);
        if (!y) continue;
        dot += x * y;
        shared.push([t, x * y]);
      }
      const overlap = dot / ((norm.get(ids[i]) || 1) * (norm.get(ids[j]) || 1));
      if (overlap < MIN_OVERLAP) continue;
      const [lo, hi] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      edges.push({ a: lo, b: hi, overlap: Math.round(overlap * 1000) / 1000, topics: top(shared, 5) });
    }
  }
  edges.sort((p, q) => q.overlap - p.overlap);
  const galaxies = galaxiesOf(ids, edges).map((members) => {
    // The topics that most of its groups share, weighed across them.
    const weight = new Map<string, number>();
    const count = new Map<string, number>();
    for (const m of members) {
      for (const [t, w] of vec.get(m)!) {
        weight.set(t, (weight.get(t) ?? 0) + w);
        count.set(t, (count.get(t) ?? 0) + 1);
      }
    }
    return { members, topics: top([...weight].filter(([t]) => (count.get(t) ?? 0) >= 2), 4) };
  });
  return { day, from, to, nodes, edges, galaxies };
}

/**
 * The first `k` terms to show, without saying a word twice: of a word and a longer term holding it
 * ("比特币", "比特币跌"), the word.
 */
export function pick(ranked: string[], k: number): string[] {
  const out: string[] = [];
  for (const t of ranked) {
    if (out.some((c) => t.includes(c))) continue;
    const longer = out.findIndex((c) => c.includes(t));
    if (longer >= 0) out[longer] = t;
    else out.push(t);
    if (out.length >= k) break;
  }
  return [...new Set(out)];
}

/**
 * Groups that belong together: average-linkage clustering of the overlaps, merging while two
 * clusters' groups overlap at least `at` on average. Only clusters of two or more are galaxies.
 */
export function galaxiesOf(ids: number[], edges: MapEdge[], at = GALAXY_AT): number[][] {
  const w = new Map(edges.map((e) => [`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`, e.overlap]));
  const between = (x: number, y: number) => w.get(`${Math.min(x, y)}:${Math.max(x, y)}`) ?? 0;
  let clusters = ids.map((id) => [id]);
  for (;;) {
    let best: [number, number] | null = null;
    let bestScore = at;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let sum = 0;
        for (const x of clusters[i]) for (const y of clusters[j]) sum += between(x, y);
        const avg = sum / (clusters[i].length * clusters[j].length);
        if (avg >= bestScore) {
          bestScore = avg;
          best = [i, j];
        }
      }
    }
    if (!best) break;
    const [i, j] = best;
    const merged = [...clusters[i], ...clusters[j]];
    clusters = clusters.filter((_, k) => k !== i && k !== j);
    clusters.push(merged);
  }
  return clusters.filter((c) => c.length >= 2).map((c) => c.slice().sort((x, y) => x - y)).sort((x, y) => y.length - x.length || x[0] - y[0]);
}

/** The last `count` days in the time zone, today (so far) first: each from its local midnight. */
export function lastDays(now: number, timezone: string, count: number): { day: string; from: number; to: number }[] {
  const out: { day: string; from: number; to: number }[] = [];
  let to = now;
  let from = lastSlot(now, timezone, 0);
  for (let i = 0; i < count; i++) {
    out.push({ day: localDate(from, timezone), from, to });
    to = from;
    from = lastSlot(from - 1, timezone, 0);
  }
  return out;
}
