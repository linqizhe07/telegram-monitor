// Every string a group member sees, in English and Simplified Chinese.

import type { Section } from './schema.ts';

export type UiLang = 'en' | 'zh';

export interface Strings {
  digestTitle(title: string): string;
  stats(messages: number, people: number): string;
  tldr: string;
  sections: Record<Section, string>;
  whyNow: string;
  next: string;
  streak(n: number): string;
  quiet: string;
  footer(version: number): string;
  useful(n: number): string;
  notUseful(n: number): string;
  voteRecorded: string;
  voteCleared: string;

  intro(days: number): string;
  cannotRead: string;
  privateInstance: string;
  privateStart(userId: number): string;
  working(hours: number): string;
  notEnough(count: number, hours: number): string;
  cooldown(minutes: number): string;
  failed(reason: string): string;
  adminOnly: string;
  optedOut(deleted: number): string;
  alreadyOptedOut: string;
  optedIn: string;
  feedbackThanks: string;
  feedbackUsage: string;
  noDigestYet: string;
  status(p: { title: string; messages: number; people: number; next: string; version: number; mode: string; days: number }): string;
  help: string;
  settings(p: { hour: number; timezone: string; language: string; mode: string; here: boolean }): string;
  settingsSaved: string;
  settingsBad: string;

  rsiHeader(p: { version: number; since: string; mode: string; cost: string }): string;
  rsiLine(p: { version: number; operator: string; ok: boolean; summary: string; why: string }): string;
  rsiNoLineage: string;
  rsiVotes(up: number, down: number): string;
  rsiNotes: string;
  rsiFooter: string;
  evolving: string;
  evolveSkipped(reason: string): string;
  promoted(p: { from: number; to: number; rationale: string; days: number; judge: string; grounding: string; coverage: string }): string;
  pending(p: { from: number; to: number; rationale: string; days: number; judge: string }): string;
  approve: string;
  reject: string;
  approved(from: number, to: number): string;
  rejected(version: number): string;
  held(reason: string): string;
  vetoed(p: { from: number; to: number; up: number; down: number }): string;
  rolledBack(from: number, to: number): string;
  nothingToRollBack: string;
  modes: Record<'auto' | 'propose' | 'off', string>;
  langNames: Record<'auto' | 'en' | 'zh', string>;
}

const en: Strings = {
  digestTitle: (title) => `📡 ${title}`,
  stats: (m, p) => `${m} messages · ${p} people`,
  tldr: 'TL;DR',
  sections: {
    topics: '🧭 Topics',
    pain_points: '😣 Pain points',
    ideas: '💡 New ideas',
    opportunities: '🎯 Opportunities',
    open_questions: '❓ Open questions',
  },
  whyNow: 'why now',
  next: 'next',
  streak: (n) => `↻ day ${n}`,
  quiet: 'A quiet day: not much of substance was said.',
  footer: (v) => `🧬 playbook v${v} · improves itself · /rsi`,
  useful: (n) => `👍 Useful${n ? ` · ${n}` : ''}`,
  notUseful: (n) => `👎 Not useful${n ? ` · ${n}` : ''}`,
  voteRecorded: 'Thanks! Votes steer how the digest improves itself.',
  voteCleared: 'Vote removed.',

  intro: (days) =>
    `👋 Pulse is here. Once a day I post a digest of this group: topics, pain points, new ideas, opportunities and open questions, each linked to the messages behind it.\n\n` +
    `• I keep messages for ${days} days and send them to the Claude API for analysis, with names replaced by aliases.\n` +
    `• /optout leaves your messages out (and deletes what I stored); /optin brings them back.\n` +
    `• 👍/👎 under a digest, or a reply to it, teaches the digest what this group values. /rsi shows how it is improving itself.\n` +
    `• /digest now · /settings (admins) · /help`,
  cannotRead:
    '⚠️ I can only see commands right now. To read the group, either make me an admin, or turn privacy mode off in @BotFather (/setprivacy → Disable) and add me to the group again.',
  privateInstance: 'This Pulse instance is private, so I am leaving. Run your own: it is open source.',
  privateStart: (id) =>
    `👋 I am Pulse. Add me to a group and I will post a daily digest of it: topics, pain points, ideas, opportunities, open questions.\n\nYour Telegram user id is <code>${id}</code> (put it in PULSE_OWNER_IDS if you run this bot).`,
  working: (h) => `⏳ Reading the last ${h}h…`,
  notEnough: (c, h) => `Only ${c} message${c === 1 ? '' : 's'} in the last ${h}h: not enough for a digest yet.`,
  cooldown: (m) => `A digest was made a moment ago. Try again in ${m} min.`,
  failed: (r) => `⚠️ I could not write the digest this time (${r}).`,
  adminOnly: 'Only group admins can do that.',
  optedOut: (n) => `Done: your messages are left out of digests in this group${n ? `, and the ${n} I had stored are deleted` : ''}. /optin undoes it.`,
  alreadyOptedOut: 'You are already opted out here. /optin undoes it.',
  optedIn: 'Welcome back: your new messages count again.',
  feedbackThanks: 'Thanks, noted. It goes into the next self-improvement round.',
  feedbackUsage: 'Reply to a digest, or write: /feedback what the digest should do better',
  noDigestYet: 'No digest has been posted here yet.',
  status: (p) =>
    `📡 <b>Pulse · ${p.title}</b>\n` +
    `Last 24h: ${p.messages} messages from ${p.people} people\n` +
    `Next digest: ${p.next}\n` +
    `Playbook v${p.version} · self-improvement: ${p.mode}\n` +
    `Messages are kept ${p.days} days · /optout`,
  help:
    '<b>Pulse commands</b>\n' +
    '/digest [hours] — digest now (default 24h)\n' +
    '/pulse — status\n' +
    '/rsi — how the digest is improving itself · /rsi playbook · /rsi evolve · /rsi rollback\n' +
    '/feedback &lt;text&gt; — tell the digest what to do better (or reply to a digest)\n' +
    '/optout · /optin — leave your messages out, or back in\n' +
    '/settings — time, time zone, language, self-improvement mode (admins)',
  settings: (p) =>
    `⚙️ <b>Settings</b>\n` +
    `Digest: every day at ${String(p.hour).padStart(2, '0')}:00 (${p.timezone}) · <code>/settings hour 21</code> · <code>/settings tz Europe/London</code>\n` +
    `Language: ${p.language} · <code>/settings lang auto|en|zh</code>\n` +
    `Self-improvement: ${p.mode} · <code>/settings rsi auto|propose|off</code>\n` +
    `Posted to: ${p.here ? 'this topic' : 'the main chat'} · <code>/settings here</code> inside a forum topic to post there`,
  settingsSaved: '✓ Saved.',
  settingsBad: 'Did not understand that. /settings shows the options.',

  rsiHeader: (p) =>
    `🧬 <b>Self-improvement</b> · playbook v${p.version}${p.since ? ` (since ${p.since})` : ''}\n` +
    `Mode: ${p.mode} · model spend, last 7 days: ${p.cost}`,
  rsiLine: (p) => `${p.ok ? '✓' : '✗'} v${p.version} [${p.operator}] ${p.summary}${p.why ? ` — ${p.why}` : ''}`,
  rsiNoLineage: 'No self-improvement round yet. The first runs after the first daily digest.',
  rsiVotes: (u, d) => `Reader votes on the current playbook: 👍 ${u} 👎 ${d}`,
  rsiNotes: 'Improver strategy notes (written by the improver, for itself):',
  rsiFooter: '/rsi playbook — the full playbook · /rsi evolve — run a round now · /rsi rollback — go back one version (admins)',
  evolving: '🧬 Running a self-improvement round. This takes a few minutes.',
  evolveSkipped: (r) => `🧬 No round this time: ${r}.`,
  promoted: (p) =>
    `🧬 <b>Pulse rewrote its own playbook: v${p.from} → v${p.to}</b>\n` +
    `What changed: ${p.rationale}\n` +
    `How it was checked: blind head-to-head with v${p.from} on the last ${p.days} day${p.days === 1 ? '' : 's'}; judge win rate ${p.judge}; citations verified ${p.grounding}; busiest conversations covered ${p.coverage}.\n` +
    `Worse for you? 👎 the next digests: 3 down-votes send it back to v${p.from}. /rsi has the full record.`,
  pending: (p) =>
    `🧬 <b>Proposed playbook v${p.to}</b> (now v${p.from})\n` +
    `What changes: ${p.rationale}\n` +
    `Blind head-to-head on the last ${p.days} day${p.days === 1 ? '' : 's'}: judge win rate ${p.judge}. Admins decide:`,
  approve: '✅ Adopt',
  reject: '❌ Reject',
  approved: (f, t) => `✅ Playbook v${t} adopted (was v${f}).`,
  rejected: (v) => `❌ Playbook v${v} rejected.`,
  held: (r) => `🧬 Self-improvement round done: kept the current playbook (${r}).`,
  vetoed: (p) => `🧬 Readers voted playbook v${p.from} down (👎 ${p.down} · 👍 ${p.up}), so it is rolled back to v${p.to}.`,
  rolledBack: (f, t) => `↩️ Rolled back from playbook v${f} to v${t}.`,
  nothingToRollBack: 'The current playbook has no earlier version to go back to.',
  modes: { auto: 'auto (adopts what wins)', propose: 'propose (admins approve)', off: 'off' },
  langNames: { auto: 'auto', en: 'English', zh: '中文' },
};

const zh: Strings = {
  digestTitle: (title) => `📡 ${title}`,
  stats: (m, p) => `${m} 条消息 · ${p} 人`,
  tldr: '一句话',
  sections: {
    topics: '🧭 话题',
    pain_points: '😣 痛点',
    ideas: '💡 新想法',
    opportunities: '🎯 机会',
    open_questions: '❓ 悬而未决',
  },
  whyNow: '为什么是现在',
  next: '下一步',
  streak: (n) => `↻ 第${n}天`,
  quiet: '今天比较安静，没什么实质讨论。',
  footer: (v) => `🧬 playbook v${v} · 自我进化中 · /rsi`,
  useful: (n) => `👍 有用${n ? ` · ${n}` : ''}`,
  notUseful: (n) => `👎 没用${n ? ` · ${n}` : ''}`,
  voteRecorded: '收到！投票会影响摘要怎么改进自己。',
  voteCleared: '已撤回投票。',

  intro: (days) =>
    `👋 Pulse 来了。我每天发一份本群速览：话题、痛点、新想法、机会、悬而未决的问题，每条都链接到原消息。\n\n` +
    `• 消息保留 ${days} 天，发给 Claude API 分析，分析前把名字换成代号。\n` +
    `• /optout 不收录你的消息（并删除已存的），/optin 恢复。\n` +
    `• 在摘要下点 👍/👎，或直接回复摘要，它就会学这个群看重什么。/rsi 看它怎么改进自己。\n` +
    `• /digest 立即出一份 · /settings（管理员）· /help`,
  cannotRead:
    '⚠️ 我现在只能看到命令。要读群消息：把我设为管理员，或在 @BotFather 关闭隐私模式（/setprivacy → Disable）后重新拉我进群。',
  privateInstance: '这个 Pulse 是私人部署的，我先退出了。可以自己部署一个，代码是开源的。',
  privateStart: (id) =>
    `👋 我是 Pulse。把我拉进群，我每天发一份群聊速览：话题、痛点、想法、机会、悬而未决的问题。\n\n你的 Telegram 用户 id 是 <code>${id}</code>（部署者可以填进 PULSE_OWNER_IDS）。`,
  working: (h) => `⏳ 正在读最近 ${h} 小时的消息…`,
  notEnough: (c, h) => `最近 ${h} 小时只有 ${c} 条消息，还不够出摘要。`,
  cooldown: (m) => `刚出过一份，${m} 分钟后再试。`,
  failed: (r) => `⚠️ 这次没能写出摘要（${r}）。`,
  adminOnly: '只有群管理员可以这样做。',
  optedOut: (n) => `好了：本群摘要不再收录你的消息${n ? `，已存的 ${n} 条也删了` : ''}。/optin 可恢复。`,
  alreadyOptedOut: '你已经退出了。/optin 可恢复。',
  optedIn: '欢迎回来：你之后的消息会重新收录。',
  feedbackThanks: '收到，会进入下一轮自我改进。',
  feedbackUsage: '直接回复某份摘要，或者写：/feedback 希望摘要改进的地方',
  noDigestYet: '这个群还没发过摘要。',
  status: (p) =>
    `📡 <b>Pulse · ${p.title}</b>\n` +
    `近 24 小时：${p.messages} 条消息，${p.people} 人\n` +
    `下一份摘要：${p.next}\n` +
    `playbook v${p.version} · 自我进化：${p.mode}\n` +
    `消息保留 ${p.days} 天 · /optout`,
  help:
    '<b>Pulse 命令</b>\n' +
    '/digest [小时] — 立即出摘要（默认 24 小时）\n' +
    '/pulse — 状态\n' +
    '/rsi — 摘要怎么改进自己 · /rsi playbook · /rsi evolve · /rsi rollback\n' +
    '/feedback &lt;内容&gt; — 告诉摘要哪里该改（也可以直接回复摘要）\n' +
    '/optout · /optin — 不收录 / 恢复收录你的消息\n' +
    '/settings — 时间、时区、语言、自我进化模式（管理员）',
  settings: (p) =>
    `⚙️ <b>设置</b>\n` +
    `摘要：每天 ${String(p.hour).padStart(2, '0')}:00（${p.timezone}）· <code>/settings hour 21</code> · <code>/settings tz Asia/Shanghai</code>\n` +
    `语言：${p.language} · <code>/settings lang auto|en|zh</code>\n` +
    `自我进化：${p.mode} · <code>/settings rsi auto|propose|off</code>\n` +
    `发到：${p.here ? '这个话题' : '主聊天'} · 在论坛话题里发 <code>/settings here</code> 就发到该话题`,
  settingsSaved: '✓ 已保存。',
  settingsBad: '没看懂。/settings 可以看所有选项。',

  rsiHeader: (p) =>
    `🧬 <b>自我进化</b> · 当前 playbook v${p.version}${p.since ? `（${p.since} 起）` : ''}\n` +
    `模式：${p.mode} · 近 7 天模型花费：${p.cost}`,
  rsiLine: (p) => `${p.ok ? '✓' : '✗'} v${p.version} [${p.operator}] ${p.summary}${p.why ? ` — ${p.why}` : ''}`,
  rsiNoLineage: '还没跑过自我进化。第一份每日摘要之后会跑第一轮。',
  rsiVotes: (u, d) => `读者对当前 playbook 的投票：👍 ${u} 👎 ${d}`,
  rsiNotes: '改进者的策略笔记（它写给自己的）：',
  rsiFooter: '/rsi playbook 看完整规则 · /rsi evolve 立即跑一轮 · /rsi rollback 回退一个版本（管理员）',
  evolving: '🧬 正在跑一轮自我改进，需要几分钟。',
  evolveSkipped: (r) => `🧬 这次没跑：${r}。`,
  promoted: (p) =>
    `🧬 <b>Pulse 改写了自己的 playbook：v${p.from} → v${p.to}</b>\n` +
    `改了什么：${p.rationale}\n` +
    `怎么验证的：在最近 ${p.days} 天的聊天上和 v${p.from} 盲测对比，评审胜率 ${p.judge}；引用核验 ${p.grounding}；热门讨论覆盖 ${p.coverage}。\n` +
    `觉得变差了？给接下来的摘要点 👎，3 票就自动退回 v${p.from}。/rsi 有完整记录。`,
  pending: (p) =>
    `🧬 <b>建议采用 playbook v${p.to}</b>（当前 v${p.from}）\n` +
    `改动：${p.rationale}\n` +
    `在最近 ${p.days} 天上盲测对比，评审胜率 ${p.judge}。请管理员决定：`,
  approve: '✅ 采用',
  reject: '❌ 不采用',
  approved: (f, t) => `✅ 已采用 playbook v${t}（原 v${f}）。`,
  rejected: (v) => `❌ 没有采用 playbook v${v}。`,
  held: (r) => `🧬 这一轮跑完了：保留当前 playbook（${r}）。`,
  vetoed: (p) => `🧬 读者给 playbook v${p.from} 投了反对（👎 ${p.down} · 👍 ${p.up}），已自动退回 v${p.to}。`,
  rolledBack: (f, t) => `↩️ 已从 playbook v${f} 回退到 v${t}。`,
  nothingToRollBack: '当前 playbook 没有更早的版本可以回退。',
  modes: { auto: '自动（赢了就采用）', propose: '提议（管理员批准）', off: '关闭' },
  langNames: { auto: '自动', en: 'English', zh: '中文' },
};

export const STRINGS: Record<UiLang, Strings> = { en, zh };

export function strings(lang: UiLang): Strings {
  return STRINGS[lang];
}
