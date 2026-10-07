// What agents read through the MCP server, beyond one group's window: a link for every message,
// what is new since a reader last looked, search across the groups, a message in its context, what
// needs attention, past digests, and the service's health in one view. All of it reads the local
// database; nothing here asks Telegram.

import { denoise, formatSignal } from './denoise.ts';
import { digestFolders } from './digest-folders.ts';
import { toPlain } from './render.ts';
import type { ActivityRow, ChatRow, Store, StoredMessage, UserRow } from './store.ts';
import { messageLink } from './telegram.ts';
import { localDate, localTime } from './transcript.ts';

export { messageLink };

/**
 * The groups and channels read, in the order list_sources and status number them (#1, #2…):
 * switched-off ones included, and in the order they were added, so a new one takes the next
 * number and none of the others moves.
 */
export function sourcesOf(store: Store): ChatRow[] {
  return store
    .listChats(false)
    .filter((c) => c.kind === 'watched' || c.kind === 'group')
    .sort((a, b) => a.createdAt - b.createdAt || a.chatId - b.chatId);
}

/** How to link any message of the chat: its link with <id> in place of the message id. */
export function linkPattern(c: Pick<ChatRow, 'chatId' | 'username'>): string | null {
  return messageLink(c, 1)?.replace(/\/1$/, '/<id>') ?? null;
}

export const when = (t: number | null, tz: string): string => (t ? `${localDate(t, tz)} ${localTime(t, tz)}` : '—');

const CLIENTS: Record<string, string> = { 'claude-ai': 'Claude Desktop', 'claude-code': 'Claude Code' };

/** The app an MCP client says it is (clientInfo.name), as a short label: "Claude Desktop". */
export function clientLabel(raw: unknown): string {
  const name = String(raw ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 40);
  return CLIENTS[name] ?? name;
}

/** One message as a line: [#id time name ↩replied-to ♥reactions] text. */
export function messageLine(m: StoredMessage, name: (userId: number) => string, time: (t: number) => string, maxChars: number): string {
  const tags = [`#${m.messageId}`, time(m.date), name(m.userId)];
  if (m.replyTo !== null) tags.push(`↩${m.replyTo}`);
  if (m.reactions > 0) tags.push(`♥${m.reactions}`);
  if (m.edited) tags.push('edited');
  return `[${tags.join(' ')}] ${m.text.replace(/\s+/g, ' ').slice(0, maxChars)}`;
}

// ── where each reader stopped ──────────────────────────────────────────────

/** A reader's name: what a scheduled task or a conversation calls its place in the stream. */
export function readerName(raw: string | undefined): string {
  const n = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return n || 'default';
}

export interface Place {
  row: number;
  at: number;
  /** Which storage the row counts in: clearing the messages starts the positions over. */
  epoch?: number;
}

const epochOf = (store: Store) => Number(store.getKv('messages_epoch') ?? 0);

export type PlaceKind = 'messages' | 'alerts';

export function placeOf(store: Store, kind: PlaceKind, reader: string): Place | null {
  const raw = store.getKv(`agent_${kind}:${reader}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Place;
    return Number.isFinite(p.row) && p.row >= 0 ? p : null;
  } catch {
    return null;
  }
}

export function setPlace(store: Store, kind: PlaceKind, reader: string, row: number, now: number, epoch = epochOf(store)): void {
  store.setKv(`agent_${kind}:${reader}`, JSON.stringify(kind === 'messages' ? { row, at: now, epoch } : { row, at: now }));
}

// ── what is new since a reader last looked ─────────────────────────────────

export interface NewMessages {
  /** Read after position `from`, up to and including `to`: the reader's place moves to `to`. */
  from: number;
  to: number;
  /** More was stored after `to` than fit in one answer. */
  more: boolean;
  /** kept: from the reader's place. first: no place yet. reset: the place was past everything stored (storage was cleared). The last two start `firstHours` back. */
  started: 'kept' | 'first' | 'reset';
  groups: { chat: ChatRow; messages: StoredMessage[] }[];
  count: number;
  /** How many were waiting after `from`, per chat, before this answer. */
  waiting: Map<number, number>;
  /** On a first look, the older messages of the window left out so the newest fit (they stay readable with read_messages). */
  skipped: number;
  /** The storage generation the place counts in (see Place.epoch). */
  epoch: number;
}

const MAX_ROWS = 4000;

type Users = (chatId: number) => Map<number, UserRow>;

/** Messages by group, in the order of `chats`, each oldest first. */
export function groupByChat(chats: ChatRow[], rows: StoredMessage[]): { chat: ChatRow; messages: StoredMessage[] }[] {
  const byChat = new Map<number, StoredMessage[]>();
  for (const m of rows) {
    const list = byChat.get(m.chatId);
    if (list) list.push(m);
    else byChat.set(m.chatId, [m]);
  }
  return chats.filter((c) => byChat.has(c.chatId)).map((chat) => ({ chat, messages: byChat.get(chat.chatId)!.sort((a, b) => a.date - b.date || a.messageId - b.messageId) }));
}

/** One section per group: what came in, denoised the way read_messages does it (view "signal"), or every message (view "all"). */
export function formatGroups(groups: { chat: ChatRow; messages: StoredMessage[] }[], users: Users, view: 'signal' | 'all', maxMessageChars: number): string[] {
  return groups.map(({ chat, messages }) => {
    const people = users(chat.chatId);
    const name = (id: number) => people.get(id)?.displayName ?? String(id);
    const time = (t: number) => localTime(t, chat.timezone);
    const link = linkPattern(chat);
    const head = `## ${chat.title} · ${messages.length} new · ${when(messages[0].date, chat.timezone)} → ${when(messages[messages.length - 1].date, chat.timezone)} (${chat.timezone})${link ? ` · message links: ${link}` : ''}`;
    if (view === 'all') return [head, ...messages.map((m) => messageLine(m, name, time, maxMessageChars))].join('\n');
    const sig = formatSignal(denoise(messages), name, time, 'signal');
    return [head, sig.header, ...sig.blocks, ...(sig.folded ? [sig.folded] : [])].join('\n');
  });
}

/**
 * The most messages from one end of `rows` (the oldest, or with `newest` the newest) whose
 * formatted answer fits `budget` characters; always at least one. The answer is measured as it
 * will be shown, so in view "signal" what the denoiser drops or folds costs nothing.
 */
function fitting(rows: StoredMessage[], newest: boolean, budget: number, size: (rs: StoredMessage[]) => number): number {
  const take = (k: number) => (newest ? rows.slice(rows.length - k) : rows.slice(0, k));
  if (rows.length === 0) return 0;
  const all = size(rows);
  if (all <= budget) return rows.length;
  // A first guess from the whole batch's size, then a binary search around it.
  let lo = 1;
  let hi = rows.length;
  const guess = Math.max(1, Math.min(rows.length - 1, Math.floor((rows.length * budget) / all)));
  if (size(take(guess)) <= budget) lo = guess;
  else hi = guess;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (size(take(mid)) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Messages stored after the reader's place, in storage order: a message is new when it reached the
 * store after the reader last looked, whatever its date, so what a catch-up brought in after an
 * outage is new too. From a kept place, the oldest that fit in `budget` characters come first and
 * the rest wait for the next call: nothing is skipped. A first look shows the newest that fit and
 * starts the reader's place there, so a busy day does not take dozens of calls to get through.
 * The budget counts the answer as it will be shown (view "signal" denoised and folded).
 */
export function newMessages(
  store: Store,
  o: { place: Place | null; chats: ChatRow[]; now: number; firstHours: number; budget: number; maxMessageChars: number; view?: 'signal' | 'all' },
): NewMessages {
  const ids = o.chats.map((c) => c.chatId);
  const epoch = epochOf(store);
  const started: NewMessages['started'] = !o.place ? 'first' : (o.place.epoch ?? 0) !== epoch || o.place.row > store.lastMessageRow() ? 'reset' : 'kept';
  const from = started === 'kept' ? o.place!.row : store.rowBefore(ids, o.now - o.firstHours * 3600);
  const waiting = store.countAfterRow(from, ids);
  const total = [...waiting.values()].reduce((s, x) => s + x, 0);
  const cache = new Map<number, Map<number, UserRow>>();
  const users: Users = (chatId) => {
    let u = cache.get(chatId);
    if (!u) cache.set(chatId, (u = store.users(chatId)));
    return u;
  };
  const size = (rs: StoredMessage[]) => formatGroups(groupByChat(o.chats, rs), users, o.view ?? 'signal', o.maxMessageChars).reduce((s, x) => s + x.length + 1, 0);
  const newest = started !== 'kept';
  const rows = newest ? store.newestAfterRow(from, ids, MAX_ROWS) : store.messagesAfterRow(from, ids, MAX_ROWS);
  const k = fitting(rows, newest, o.budget, size);
  const taken = newest ? rows.slice(rows.length - k) : rows.slice(0, k);
  return {
    from,
    to: taken.length ? (newest ? rows[rows.length - 1].row : taken[taken.length - 1].row) : from,
    more: !newest && (k < rows.length || rows.length === MAX_ROWS),
    started,
    groups: groupByChat(o.chats, taken),
    count: taken.length,
    waiting,
    skipped: newest ? total - taken.length : 0,
    epoch,
  };
}

export function formatNew(store: Store, batch: NewMessages, view: 'signal' | 'all', maxMessageChars: number): string[] {
  return formatGroups(batch.groups, (chatId) => store.users(chatId), view, maxMessageChars);
}

// ── search across the groups ───────────────────────────────────────────────

/** "ZEC | zcash | 大零币" → the phrases; a message matches when it contains any of them. */
export function phrasesOf(query: string): string[] {
  return [...new Set(query.split('|').map((s) => s.trim()).filter(Boolean))].slice(0, 12);
}

export interface Found {
  chat: ChatRow;
  m: StoredMessage;
  author: string;
  link: string | null;
}

export function search(store: Store, o: { chats: ChatRow[]; phrases: string[]; from: number; to: number; author?: string; limit: number }): Found[] {
  const who = o.author?.trim().replace(/^@/, '').toLowerCase() || null;
  const found: Found[] = [];
  for (const chat of o.chats) {
    const users = store.users(chat.chatId);
    let rows = store.searchMessages(chat.chatId, o.from, o.to, o.phrases, who ? 2000 : o.limit);
    if (who) {
      rows = rows.filter((m) => {
        const u = users.get(m.userId);
        return Boolean(u && (u.displayName.toLowerCase().includes(who) || u.username?.toLowerCase() === who));
      });
    }
    for (const m of rows.slice(0, o.limit)) found.push({ chat, m, author: users.get(m.userId)?.displayName ?? String(m.userId), link: messageLink(chat, m.messageId) });
  }
  return found.sort((a, b) => b.m.date - a.m.date || b.m.messageId - a.m.messageId).slice(0, o.limit);
}

// ── a message in its context ───────────────────────────────────────────────

/** The messages asked for, with what they reply to (up the chain), their replies, and `around` neighbours on each side. */
export function inContext(store: Store, chat: ChatRow, ids: number[], o: { around: number; thread: boolean }): { messages: StoredMessage[]; missing: number[] } {
  const asked = store.messagesByIds(chat.chatId, ids);
  const all = new Map(asked.map((m) => [m.messageId, m]));
  const missing = ids.filter((id) => !all.has(id));
  for (const m of asked) {
    if (o.thread) {
      let up: StoredMessage | undefined = m;
      for (let i = 0; i < 8 && up && up.replyTo !== null; i++) {
        up = all.get(up.replyTo) ?? store.messagesByIds(chat.chatId, [up.replyTo])[0];
        if (up) all.set(up.messageId, up);
      }
      for (const r of store.repliesTo(chat.chatId, [m.messageId], m.date, 30)) all.set(r.messageId, r);
    }
    for (const n of store.messagesNear(chat.chatId, m, o.around, 'before')) all.set(n.messageId, n);
    for (const n of store.messagesNear(chat.chatId, m, o.around, 'after')) all.set(n.messageId, n);
  }
  return { messages: [...all.values()].sort((a, b) => a.date - b.date || a.messageId - b.messageId), missing };
}

// ── what needs attention ───────────────────────────────────────────────────

export type AlertKind = 'news-hot' | 'news-first' | 'standing' | 'owner-action' | 'service' | 'error' | 'flag';

export interface Alert {
  id: number;
  at: number;
  kind: AlertKind;
  group: string | null;
  chatId: number | null;
  text: string;
}

const OWNER_ACTION: Record<string, string> = {
  approved: 'Join approved: the account is in. If a check appears in the Telegram app, the owner answers it there.',
  verifying: 'A check is waiting for the account in this group: the owner answers it in the Telegram app.',
  paused: 'Telegram asked the account to slow down: invite checks are paused; reading goes on.',
};

export function alertOf(r: ActivityRow, chatOf: (title: string) => number | null): Alert {
  const group = r.target && r.target !== 'service' ? r.target : null;
  const base = { id: r.id, at: r.at, group, chatId: group ? chatOf(group) : null };
  if (r.actor === 'news') return { ...base, kind: r.method === 'group was first' ? 'news-first' : 'news-hot', text: r.detail };
  if (r.actor === 'notify') return { ...base, kind: 'owner-action', text: OWNER_ACTION[r.method] ?? r.detail };
  // Claude wrote it from what it read: information for whoever reads the alerts, not instructions.
  if (r.actor === 'claude') return { ...base, kind: 'flag', text: `Claude's note: ${r.detail}` };
  if (r.actor === 'service') return { ...base, kind: 'error', text: `internal error: ${r.detail}` };
  if (r.method === 'was off') return { ...base, group: null, chatId: null, kind: 'service', text: r.detail };
  return { ...base, kind: 'standing', text: `${r.method}${r.detail ? `: ${r.detail}` : ''}` };
}

/** Alerts after row `afterId`, oldest first; or, with `newestFirst`, the newest `limit` of them. */
export function alertsAfter(store: Store, afterId: number, limit: number, newestFirst = false): Alert[] {
  // Events name their group by title: a title two chats share names neither for sure.
  const byTitle = new Map<string, number | null>();
  for (const c of store.listChats(false)) byTitle.set(c.title, byTitle.has(c.title) ? null : c.chatId);
  return store.attention(afterId, limit, newestFirst).map((r) => alertOf(r, (t) => byTitle.get(t) ?? null));
}

// ── past digests ───────────────────────────────────────────────────────────

export interface PastDigest {
  id: number;
  at: number;
  chatId: number | null;
  group: string;
  heading: string;
  format: 'markdown' | 'html';
  delivered: boolean;
  text: string;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Every digest kept (written by Claude through save_digest, or by the service), newest first. */
export function pastDigests(store: Store): PastDigest[] {
  return digestFolders(store.outbox(500), store.recentDigests(500), store.listChats(false))
    .filter((f) => f.key !== 'other')
    .flatMap((f) =>
      f.items.map((i) => ({
        id: i.id,
        at: i.at,
        chatId: f.chatId,
        group: f.title,
        heading: i.heading,
        format: i.format,
        delivered: i.delivered,
        text: i.format === 'markdown' ? i.body.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m) : toPlain(i.body),
      })),
    )
    .sort((a, b) => b.at - a.at || b.id - a.id);
}

// ── health in one view ─────────────────────────────────────────────────────

/** What only the running service knows (its console's /api/state); null when it is not running. */
export interface LiveState {
  startedAt: number;
  account: { connection: { state: 'online' | 'offline'; since: number } | null } | null;
  /** How often the chats the account is in are checked for new messages (one request for all of them). */
  peekSeconds?: number;
  sources: { chatId: number; pushed: boolean; peeked: boolean; member: boolean; everyS: number; behind: boolean }[];
}

export interface SourceStatus {
  /** The #n every tool's `source` takes. */
  n: number;
  chatId: number;
  title: string;
  ref: string;
  on: boolean;
  offReason: string | null;
  access: string | null;
  /** How often it is read, from the running service; null when it is not running. */
  reading: string | null;
  messages24h: number;
  people24h: number;
  newestAt: number | null;
  caughtUpAt: number | null;
  behind: boolean | null;
  error: string | null;
  links: string | null;
}

export interface StatusView {
  at: number;
  service: { running: boolean; startedAt: number | null; telegram: 'online' | 'offline' | 'unknown'; telegramSince: number | null };
  sources: SourceStatus[];
  autoReadNewGroups: boolean;
  last24h: { messagesStored: number; reads: number; writes: number; errors: number; connectionDrops: number; failedPulls: number; feedFailures: number };
  /** What is wrong now, as sentences. Empty when all is well. */
  problems: string[];
  news: { on: boolean; feeds: number; failing: string[]; items24h: number; alerts24h: number };
  privateGroups: { invitesFollowed: number; checksWaiting: string[] };
  claude: { actions24h: number; digests24h: number; flags24h: number };
  lastWrite: { at: number; method: string; target: string } | null;
}

/** How a source is read: pushed by Telegram, checked with the account's other chats every few seconds, or read on its own. */
function readingOf(l: LiveState['sources'][number], peekSeconds: number | null): string {
  if (l.pushed) return `pushed live by Telegram (a full read every ${l.everyS}s besides)`;
  if (l.peeked && peekSeconds) return `checked for new messages every ${peekSeconds}s (a full read every ${l.everyS}s besides)`;
  return `read every ${l.everyS}s`;
}

const OFF_REASON: Record<string, string> = { owner: 'switched off by the owner', claude: 'switched off by Claude', left: 'the account left it in Telegram', 'auto-watch off': 'new; auto-read is off', banned: 'banned' };
const FOLLOWING = new Set(['requested', 'joined', 'verifying', 'watching']);

export function statusView(store: Store, o: { now: number; running: boolean; live: LiveState | null; newsOn: boolean; autoReadDefault: boolean }): StatusView {
  const day = o.now - 86_400;
  const stats = store.messageStats(day);
  const live = new Map((o.live?.sources ?? []).map((s) => [s.chatId, s]));
  const sources: SourceStatus[] = sourcesOf(store).map((c, i) => {
    const st = stats.get(c.chatId);
    const probeJson = store.getKv(`probe:${c.chatId}`);
    let access: string | null = c.readerOrigin === 'dialog' ? 'member' : null;
    try {
      const p = probeJson ? (JSON.parse(probeJson) as { member?: boolean; verdict?: string }) : null;
      if (p) access = p.member ? 'member' : p.verdict === 'read-from-outside' ? 'outside' : (p.verdict ?? access);
    } catch {
      // an unreadable probe result says nothing
    }
    const l = live.get(c.chatId);
    const off = c.enabled ? null : store.getKv(`reader_off_reason:${c.chatId}`) || null;
    return {
      n: i + 1,
      chatId: c.chatId,
      title: c.title,
      ref: c.readerRef ?? (c.username ? `@${c.username}` : String(c.chatId)),
      on: c.enabled,
      offReason: off ? (OFF_REASON[off] ?? off) : null,
      access,
      reading: l && c.enabled ? readingOf(l, o.live?.peekSeconds ?? null) : null,
      messages24h: st?.count ?? 0,
      people24h: st?.people ?? 0,
      newestAt: st?.newest ?? null,
      caughtUpAt: Number(store.getKv(`reader_caught_up:${c.chatId}`) ?? 0) || null,
      behind: l ? l.behind : null,
      error: c.readerError,
      links: linkPattern(c),
    };
  });
  const tally = store.activityTally(day);
  const count = (actor: string, method: string) => tally.filter((t) => t.actor === actor && t.method === method).reduce((s, t) => s + t.n, 0);
  const summary = store.activitySummary(day);
  const feeds = store.newsSources().filter((x) => x.enabled && x.kind === 'rss');
  const failing = feeds.filter((x) => x.lastError).map((x) => x.name);
  const memberships = store.memberships();
  const titles = new Map(store.listChats(false).map((c) => [c.chatId, c.title]));
  const waiting = memberships.filter((m) => m.state === 'verifying').map((m) => titles.get(m.chatId) ?? String(m.chatId));
  const telegram = o.live?.account?.connection?.state ?? 'unknown';

  const problems: string[] = [];
  if (!o.running) problems.push('The monitor service is not running: nothing new is captured until it starts again (npm start in the project folder). What was stored can still be read.');
  // Only the running service knows the account and the connection; without its answer, say nothing about them.
  if (o.running && o.live && !o.live.account) problems.push('The reader account is not signed in (npm run login).');
  if (telegram === 'offline') problems.push(`The connection to Telegram is down since ${when(o.live!.account!.connection!.since, 'UTC')} UTC; it retries by itself.`);
  for (const s of sources) {
    if (!s.on) continue;
    if (s.error) problems.push(`${s.title}: ${s.error}`);
    if (s.behind) problems.push(`${s.title}: still catching up.`);
    if (o.running && s.caughtUpAt && o.now - s.caughtUpAt > 30 * 60) problems.push(`${s.title}: last caught up ${Math.round((o.now - s.caughtUpAt) / 60)} min ago.`);
  }
  for (const title of waiting) problems.push(`${title}: a check is waiting for the account; the owner answers it in the Telegram app.`);
  if (o.newsOn && failing.length) problems.push(`News feeds not answering: ${failing.join(', ')}.`);

  const lw = summary.lastWrite;
  return {
    at: o.now,
    service: { running: o.running, startedAt: o.live?.startedAt ?? null, telegram, telegramSince: o.live?.account?.connection?.since ?? null },
    sources,
    autoReadNewGroups: (store.getKv('auto_watch_new') || (o.autoReadDefault ? 'on' : 'off')) === 'on',
    last24h: {
      messagesStored: [...stats.values()].reduce((s, x) => s + x.count, 0),
      reads: summary.counts.read ?? 0,
      writes: summary.counts.write ?? 0,
      errors: summary.errors,
      connectionDrops: count('reader', 'connection lost'),
      failedPulls: count('reader', 'pull failed'),
      feedFailures: count('news', 'feed failed'),
    },
    problems,
    news: {
      on: o.newsOn,
      feeds: feeds.length,
      failing,
      items24h: [...store.newsItemCounts(day).values()].reduce((s, x) => s + x, 0),
      alerts24h: store.newsAlerts(day).filter((a) => a.kind !== 'echo').length,
    },
    privateGroups: { invitesFollowed: store.invites().filter((x) => FOLLOWING.has(x.state)).length, checksWaiting: waiting },
    claude: {
      actions24h: tally.filter((t) => t.actor === 'claude').reduce((s, t) => s + t.n, 0),
      digests24h: count('claude', 'digest saved'),
      flags24h: count('claude', 'flagged'),
    },
    lastWrite: lw ? { at: lw.at, method: lw.method, target: lw.target } : null,
  };
}
