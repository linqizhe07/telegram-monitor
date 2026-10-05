// Denoising a busy group before anyone reads it: thousands of messages a day are mostly fragments,
// stickers, "哈哈", copy-paste waves and DM-me scams. This keeps what carries information, says
// exactly what it dropped and why, and never drops a message people engaged with (replies,
// reactions). It is deterministic code: the model then reads the signal, not the noise.

import type { StoredMessage } from './store.ts';

export type NoiseKind = 'sticker' | 'chatter' | 'command' | 'spam' | 'repeat';

export interface SignalLine {
  /** Message ids merged into this line (one person's consecutive fragments), first = cite this. */
  ids: number[];
  userId: number;
  date: number;
  text: string;
  replyTo: number | null;
  reactions: number;
  /** Replies other messages made to any id in this line. */
  replies: number;
  /** Same text posted again by others (a wave): how many times, by how many people. */
  echoes: { times: number; people: number } | null;
  score: number;
}

/** Lines joined by replies: one conversation. */
export interface Conversation {
  lines: SignalLine[];
  people: number;
  onTopic: boolean;
  score: number;
}

export interface Denoised {
  total: number;
  lines: SignalLine[];
  /** `lines` grouped into conversations by reply links, in order of their first line. */
  conversations: Conversation[];
  /** Messages kept (after merging, `lines` is shorter). */
  kept: number;
  removed: Record<NoiseKind, number>;
  /** A few removed examples per kind, for checking that nothing useful was dropped. */
  samples: Record<NoiseKind, string[]>;
}

// Fillers: a message made only of these says nothing on its own.
const FILLER = new RegExp(
  '^(' +
    [
      '哈+', '呵+', '嘿+', '嘻+', '哦+', '噢+', '嗯+', '啊+', '额+', '呃+', '唉+', '哎+', '诶+', '咦+', '嗷+', '哇+', '靠', '卧槽', '我靠', '握草', '尼玛', '牛+', '牛逼', '牛b', 'nb',
      '666+', '6+', '好+', '好的', '好吧', '行', '对+', '是+', '是的', '不是', '没有', '有', '在', '在吗', '来了', '来', '走', '冲+', '早', '早安', '早上好', '晚安', '午安', '睡了', '签到', '打卡',
      '谢谢', '感谢', '多谢', '收到', '了解', '懂了', '明白', '可以', '真的', '真的吗', '是吗', '为啥', '咋了', '怎么了', '什么', '啥', '？+', '\\?+', '。+', '…+', '\\.+', '!+', '！+',
      'gm', 'gn', 'hi', 'hello', 'hey', 'yo', 'ok', 'okay', 'k', 'lol', 'lmao', 'haha+', 'xd', 'yes', 'no', 'yep', 'nope', 'ty', 'thx', 'thanks', 'wow', 'nice', 'cool', 'same', 'true', 'bro', 'wtf', 'omg', '\\+1', '1',
    ].join('|') +
    ')$',
  'i',
);
// Scams and promotion: contact solicitation, invite links, "free" offers.
const SPAM = [
  /(t\.me|telegram\.me)\/(\+|joinchat\/)/i,
  /(私聊|私信|加我|找我|联系我|带单|带你|拉你|进群|vx|v信|微信|wechat|whatsapp)[^。！!\n]{0,12}(赚|收益|翻倍|稳赚|免费|领取|带单|项目|老师|客服)/i,
  /(免费领|领取空投|空投领取|充值返|返利|稳赚不赔|日赚|月入)/,
  /\b(dm me|inbox me|message me|contact me)\b.{0,40}\b(profit|earn|invest|signal|pump|recover)/i,
  /\b(recover|recovery)\b.{0,30}\b(funds|wallet|account)\b/i,
];
const MEDIA_ONLY = /^\[(sticker|gif|video note|dice)[^\]]*\]$/i;

const MERGE_GAP = 90; // seconds between one person's fragments that still count as one message

// What the monitored groups are about: crypto, trading, exchanges, money. A conversation with none
// of these anywhere is off-topic for a digest of pain points, ideas and opportunities (it is kept,
// folded, and can be opened).
const DOMAIN = new RegExp(
  [
    '币', '链', '仓', '涨', '跌', '盘', '韭菜', '割', '庄', '牛市', '熊市', '抄底', '梭哈', '套牢', '回本', '止损', '止盈', '做多', '做空', '开单', '合约', '现货', '杠杆', '爆仓', '强平', '清算', '行情', 'k线', '均线',
    '空投', '打新', '撸', '挖矿', '质押', '理财', '收益', '年化', '利息', '返佣', '邀请码', '红包', '活动', '任务', '积分', '奖励', '上线', '下架', '公告', '新币', '土狗', '项目', '赛道', '叙事',
    '钱包', '私钥', '助记词', '地址', '转账', '充值', '提现', '提币', '出金', '入金', '到账', '手续费', 'gas', '法币', '卖u', '买u', '出u', '收u', '承兑', '汇率', '电汇', '银行卡', '冻结', '风控', '封号', '解封', '认证', '实名', '客服', '工单', '申诉', '诈骗', '骗子', '被盗', '黑u', '洗钱',
    '交易所', '交易', '价格', '市值', '流动性', '稳定币', '美元', '美股', '股票', '港股', 'a股', '纳斯达克', '纳指', '标普', '黄金', '期货', '期权', '基金', '欧元', '比索', '卢布', '降息', '加息', '美联储', 'etf', 'cpi',
    'binance', '币安', 'bn', 'okx', '欧易', 'bybit', 'bitget', 'coinbase', 'kraken', 'gate', 'mexc', 'hyperliquid', 'uniswap', 'pancake', 'metamask', 'trust',
    'usdt', 'usdc', 'fdusd', 'btc', 'eth', 'bnb', 'sol', 'xrp', 'doge', 'ton', 'trx', 'sui', 'aster', 'meme', 'nft', 'defi', 'dex', 'cex', 'web3', 'bsc', 'erc', 'trc', 'p2p', 'c2c', 'otc', 'kyc', 'apy', 'apr',
    'launchpool', 'launchpad', 'megadrop', 'alpha', 'earn', 'futures', 'spot', 'margin', 'staking', 'airdrop', 'listing', 'delist', 'withdraw', 'deposit', 'wallet', 'exchange', 'trade', 'trading', 'token', 'coin', 'crypto', 'pump', 'dump', 'long', 'short', 'liquidat',
    '喊单', '带单', '上车', '下车', '财富密码', '充', '骗', '割肉', '仓位', '入场', '离场', '大饼', '姨太', '以太', 'u卡', 'qqq', 'nvda', 'tsla', '英伟达', '特斯拉', '台积电', 'luna', 'ftx', 'cz', '赵长鹏', '何一',
    '\\$[a-z]{2,10}', '\\d+(\\.\\d+)?\\s?(u|刀|万u|k|%)\\b',
  ].join('|'),
  'i',
);

export function onTopic(text: string): boolean {
  return DOMAIN.test(text);
}

/** Letters and digits only: what is left of a message without emoji, punctuation or spaces. */
export function core(text: string): string {
  return text
    .replace(/\[(sticker|gif|photo|video|voice|video note|audio|document|forwarded)[^\]]*\]/gi, '')
    // Emoji and their joiners, skin tones, flags and keycap marks; not \p{Emoji_Component}, which includes the digits 0-9.
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\uFE0E\uFE0F\u200D\u20E3]/gu, '')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .toLowerCase();
}

/** Why a message is noise, or null when it may carry information. Engagement always wins. */
export function noiseKind(m: StoredMessage, repliesTo: number): NoiseKind | null {
  if (repliesTo > 0 || m.reactions >= 2) return null;
  const text = m.text.trim();
  if (SPAM.some((re) => re.test(text))) return 'spam';
  if (/^\/[A-Za-z0-9_]{2,32}(@[A-Za-z0-9_]{3,64})?(\s|$)/.test(text)) return 'command'; // talking to a bot
  if (MEDIA_ONLY.test(text)) return 'sticker';
  const c = core(text);
  if (c.length === 0) return /\[(photo|video|document|voice|audio|poll)/i.test(text) ? null : 'sticker';
  if (FILLER.test(c)) return 'chatter';
  const cjk = (c.match(/\p{Script=Han}/gu) ?? []).length;
  // One or two characters of Chinese, or a lone short word: not enough to say anything.
  if (cjk > 0 ? c.length <= 2 : c.length <= 3 && !/\d/.test(c)) return 'chatter';
  return null;
}

function signalScore(l: Omit<SignalLine, 'score'>): number {
  const t = l.text;
  let s = Math.min(t.length, 200) / 40;
  s += l.replies * 3 + l.reactions * 1.5;
  if (l.echoes) s += Math.min(l.echoes.people, 20);
  if (/[?？]|吗$|怎么|如何|为什么|为啥|能不能|有没有|how|why|what|when|can i|does/i.test(t)) s += 2;
  if (/\$[A-Za-z]{2,10}\b|\b[A-Z]{2,6}\b|\d+(\.\d+)?\s?(%|u|usdt|btc|eth|k|w|万|亿)/i.test(t)) s += 1.5;
  if (/https?:\/\//i.test(t)) s += 1;
  if (/(提现|充值|冻结|风控|封号|kyc|认证|卡住|到账|失败|报错|bug|无法|不能|退款|手续费|滑点|爆仓|清算|延迟|withdraw|deposit|frozen|stuck|fail|error|fee)/i.test(t)) s += 2;
  if (/(建议|希望|应该|要是|如果能|功能|新功能|上线|上币|新币|活动|空投|launchpool|alpha|机会|listing|airdrop|feature|suggest)/i.test(t)) s += 2;
  return Math.round(s * 10) / 10;
}

/**
 * Splits a window into signal and noise. Messages must be oldest first. Merges one person's
 * consecutive fragments, folds copy-paste waves into one line with a count, drops stickers,
 * fillers and scams, and scores what is left.
 */
export function denoise(messages: StoredMessage[]): Denoised {
  const replies = new Map<number, number>();
  for (const m of messages) if (m.replyTo !== null) replies.set(m.replyTo, (replies.get(m.replyTo) ?? 0) + 1);

  const removed: Record<NoiseKind, number> = { sticker: 0, chatter: 0, command: 0, spam: 0, repeat: 0 };
  const samples: Record<NoiseKind, string[]> = { sticker: [], chatter: [], command: [], spam: [], repeat: [] };
  const drop = (kind: NoiseKind, m: StoredMessage) => {
    removed[kind]++;
    if (samples[kind].length < 12) samples[kind].push(m.text.slice(0, 80));
  };

  // Waves: the same text (by its core) from several posts. First one stays, with the count.
  const firstOf = new Map<string, { line: Omit<SignalLine, 'score'> | null; people: Set<number>; times: number }>();

  const lines: Omit<SignalLine, 'score'>[] = [];
  let kept = 0;
  for (const m of messages) {
    const r = replies.get(m.messageId) ?? 0;
    const kind = noiseKind(m, r);
    if (kind) {
      drop(kind, m);
      continue;
    }
    const c = core(m.text);
    if (c.length >= 3 && r === 0) {
      const wave = firstOf.get(c);
      if (wave) {
        wave.times++;
        wave.people.add(m.userId);
        if (wave.line) wave.line.echoes = { times: wave.times, people: wave.people.size };
        drop('repeat', m);
        continue;
      }
    }
    kept++;
    const prev = lines[lines.length - 1];
    const mergeable =
      prev &&
      prev.userId === m.userId &&
      m.date - prev.date <= MERGE_GAP &&
      (m.replyTo === null || prev.ids.includes(m.replyTo) || m.replyTo === prev.replyTo) &&
      prev.text.length + m.text.length < 600;
    if (mergeable) {
      prev.ids.push(m.messageId);
      prev.text = `${prev.text} / ${m.text}`;
      prev.date = m.date;
      prev.reactions += m.reactions;
      prev.replies += r;
      if (c.length >= 3) firstOf.set(c, { line: prev, people: new Set([m.userId]), times: 1 });
      continue;
    }
    const line = { ids: [m.messageId], userId: m.userId, date: m.date, text: m.text, replyTo: m.replyTo, reactions: m.reactions, replies: r, echoes: null };
    lines.push(line);
    if (c.length >= 3) firstOf.set(c, { line, people: new Set([m.userId]), times: 1 });
  }

  const scored = lines.map((l) => ({ ...l, score: signalScore(l) }));
  return { total: messages.length, kept, removed, samples, lines: scored, conversations: group(scored) };
}

/** Groups lines into conversations: a line replying to another joins its conversation. */
function group(lines: SignalLine[]): Conversation[] {
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const lineOf = new Map<number, number>();
  lines.forEach((l, i) => l.ids.forEach((id) => lineOf.set(id, i)));
  lines.forEach((l, i) => {
    const j = l.replyTo !== null ? lineOf.get(l.replyTo) : undefined;
    if (j !== undefined) parent[find(i)] = find(j);
  });
  const groups = new Map<number, SignalLine[]>();
  lines.forEach((l, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(l);
    else groups.set(root, [l]);
  });
  return [...groups.values()]
    .map((ls) => ({
      lines: ls,
      people: new Set(ls.map((l) => l.userId)).size,
      onTopic: ls.some((l) => onTopic(l.text)),
      score: Math.round(ls.reduce((s, l) => s + l.score, 0) * 10) / 10,
    }))
    .sort((a, b) => a.lines[0].date - b.lines[0].date);
}

export interface SignalText {
  /** What was removed and folded, in one paragraph. */
  header: string;
  /** One block per conversation (on-topic ones for 'signal', off-topic for 'off-topic'). */
  blocks: string[];
  /** The off-topic conversations in one paragraph (largest first), for 'signal'. */
  folded: string;
}

/** The denoised window as text for a reader (Claude): conversations as blocks, citing #ids. */
export function formatSignal(
  d: Denoised,
  name: (userId: number) => string,
  time: (unix: number) => string,
  view: 'signal' | 'off-topic' = 'signal',
): SignalText {
  const on = d.conversations.filter((c) => c.onTopic);
  const off = d.conversations.filter((c) => !c.onTopic);
  const count = (cs: Conversation[]) => cs.reduce((s, c) => s + c.lines.length, 0);
  const r = d.removed;
  const header =
    `${d.total} messages → ${r.sticker + r.chatter + r.command + r.repeat + r.spam} removed as noise ` +
    `(${r.sticker} stickers/emoji, ${r.chatter} one-word chatter, ${r.command} bot commands, ${r.repeat} repeats folded into their first copy, ${r.spam} scam/promotion) → ` +
    `${d.lines.length} lines after joining each person's consecutive fragments → ${count(on)} on-topic lines in ${on.length} conversations` +
    `${view === 'signal' ? ' (below)' : ''}, ${count(off)} off-topic lines in ${off.length} conversations${view === 'off-topic' ? ' (below)' : ' (folded)'}.`;
  const line = (l: SignalLine, indent: boolean) => {
    const tags = [`#${l.ids[0]}${l.ids.length > 1 ? `+${l.ids.length - 1}` : ''}`, time(l.date), name(l.userId)];
    if (l.replyTo !== null) tags.push(`↩${l.replyTo}`);
    if (l.reactions > 0) tags.push(`♥${l.reactions}`);
    if (l.echoes) tags.push(`×${l.echoes.times} by ${l.echoes.people}`);
    return `${indent ? '  ' : ''}[${tags.join(' ')}] ${l.text.replace(/\s+/g, ' ')}`;
  };
  const blocks = (view === 'signal' ? on : off).map((c) =>
    c.lines.length === 1 ? line(c.lines[0], false) : [`── ${c.lines.length} lines · ${c.people} people`, ...c.lines.map((l, i) => line(l, i > 0))].join('\n'),
  );
  const biggest = [...off].sort((a, b) => b.lines.length - a.lines.length).slice(0, 10);
  const folded = off.length
    ? `Folded off-topic conversations (largest first; read them with view "off-topic"): ${biggest
        .map((c) => `#${c.lines[0].ids[0]} (${c.lines.length} lines, ${c.people} people) "${c.lines[0].text.replace(/\s+/g, ' ').slice(0, 40)}"`)
        .join('; ')}.`
    : '';
  return { header, blocks, folded };
}
