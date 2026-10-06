import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Lang, RsiMode } from './config.ts';
import type { Critique, Digest } from './schema.ts';
import type { Metrics } from './rsi/fitness.ts';

export interface ChatRow {
  chatId: number;
  title: string;
  username: string | null;
  type: string;
  language: Lang;
  digestHour: number;
  timezone: string;
  /** Forum topic the digest is posted into; null = the main chat / General. */
  threadId: number | null;
  rsiMode: RsiMode;
  enabled: boolean;
  lastDigestAt: number | null;
  lastEvolveAt: number | null;
  lastCalibratedAt: number | null;
  /** Written only from reader feedback (calibration); the improver never writes it. */
  judgeNotes: string;
  /** Written by the improver about its own strategy: the recursive level. */
  improverNotes: string;
  createdAt: number;
  /**
   * group   = a group the bot sits in: recorded by the bot, digest posted into it.
   * watched = a group or channel you do not run: read by the reader account, digest posted to `reportChatId`.
   * report  = where watched digests go (your DM with the bot, or a private group): never recorded or digested.
   */
  kind: ChatKind;
  reportChatId: number | null;
  /** How the reader account finds a watched chat: @username or -100… id. */
  readerRef: string | null;
  /** Highest message id already pulled by the reader account. */
  readerCursor: number | null;
  readerError: string | null;
  /** The chat's address (JSON: type, id, access hash), saved so it is never resolved by name again. */
  readerPeer: string | null;
  /** How it became a source: 'dialog' = found in the account's own chat list; 'manual' = added by name or link. */
  readerOrigin: 'dialog' | 'manual' | null;
}

export type ChatKind = 'group' | 'watched' | 'report';

export interface UserRow {
  userId: number;
  alias: string;
  displayName: string;
  username: string | null;
}

export interface StoredMessage {
  chatId: number;
  messageId: number;
  threadId: number | null;
  userId: number;
  /** Unix seconds. */
  date: number;
  text: string;
  replyTo: number | null;
  reactions: number;
  edited: boolean;
}

export type DigestKind = 'production' | 'manual' | 'shadow';

export interface DigestRow {
  id: number;
  chatId: number;
  kind: DigestKind;
  windowStart: number;
  windowEnd: number;
  genomeVersion: number;
  digest: Digest;
  metrics: Metrics | null;
  critique: Critique | null;
  postedIds: number[];
  /** The chat the digest was posted in (the group itself, or a report chat). */
  postedChatId: number | null;
  createdAt: number;
}

export type GenomeStatus = 'champion' | 'retired' | 'rejected' | 'pending' | 'vetoed';

export interface GenomeRow {
  chatId: number;
  version: number;
  parent: number | null;
  playbook: string;
  operator: string;
  rationale: string;
  status: GenomeStatus;
  winRate: number | null;
  summary: string;
  createdAt: number;
  promotedAt: number | null;
}

export interface GenerationRow {
  id: number;
  chatId: number;
  createdAt: number;
  championVersion: number;
  decision: string;
  report: unknown;
  costUsd: number;
}

export interface UsageRow {
  chatId: number | null;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface FeedbackRow {
  digestId: number | null;
  userId: number;
  text: string;
  createdAt: number;
}

/**
 * One thing the service did: every request the reader account sends to Telegram, every message
 * the bot sends, every Claude call. The console shows these live, so nothing happens unseen.
 * read   = looks only (history, chat info, resolving a name)
 * write  = changes something others can see or the account's state (join, send, mark read, press a button)
 * system = connection upkeep (config, update state, keep-alive)
 */
export type ActivityKind = 'read' | 'write' | 'system' | 'llm' | 'event' | 'error';

export interface ActivityRow {
  id: number;
  at: number;
  /** reader | bot | engine | console | probe */
  actor: string;
  kind: ActivityKind;
  /** The Telegram method (e.g. messages.GetHistory) or a short event name. */
  method: string;
  target: string;
  detail: string;
  ok: boolean;
  ms: number | null;
}

/** A message that would have gone to Telegram, kept for the console when no bot token is set. */
export interface OutboxRow {
  id: number;
  at: number;
  /** Where it went (or would have gone): a report chat, the owner. */
  chatId: number;
  html: string;
  delivered: boolean;
  /** The group a digest is about, when the writer knew it (null for other messages and older rows). */
  sourceChatId: number | null;
}

/** An invite link being followed (docs/private-groups.md, section 2). */
export interface InviteRow {
  id: number;
  /** The full hash: needed for checks, never logged; null once the row has been done with for 30 days. */
  hash: string | null;
  createdAt: number;
  updatedAt: number;
  origin: 'console' | 'mcp';
  state: string;
  verdict: string;
  title: string;
  kind: string;
  members: number | null;
  about: string;
  /** verified, scam, fake, paid, request */
  flags: string[];
  peekUntil: number | null;
  chatId: number | null;
  /** The chat's saved address (JSON), from an "already a member" answer. */
  peer: string | null;
  said: 'joined' | 'requested' | null;
  saidAt: number | null;
  openedAt: number | null;
  joinedAt: number | null;
  checks: number;
  lastCheckAt: number | null;
  lastResult: string;
  nextCheckAt: number | null;
  /** When it reached a state it does not leave by itself (for pruning). */
  doneAt: number | null;
  note: string;
}

/** The account's own standing in a chat it joined. */
export interface MembershipRow {
  chatId: number;
  state: string;
  /** Why it is held: 'restricted' (Telegram says it cannot send) or 'bot message' (a bot addressed it). */
  cause: string;
  untilDate: number | null;
  detail: string;
  viaRequest: boolean;
  joinedAt: number | null;
  historyFrom: number | null;
  inviteId: number | null;
  checkedAt: number;
  nextCheckAt: number | null;
  checksDay: string;
  recheckCount: number;
}

/** A news source the radar reads: an RSS/Atom feed, or a Telegram channel among the sources. */
export interface NewsSourceRow {
  id: string;
  kind: 'rss' | 'telegram';
  name: string;
  url: string | null;
  tier: number;
  everyS: number;
  enabled: boolean;
  /** Shipped with the monitor (it can be switched off, not deleted). */
  builtin: boolean;
  etag: string | null;
  lastModified: string | null;
  lastFetchAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  itemsTotal: number;
  createdAt: number;
}

export interface NewsItemRow {
  id: number;
  sourceId: string;
  guid: string;
  title: string;
  summary: string;
  link: string | null;
  publishedAt: number;
  seenAt: number;
  backlog: boolean;
}

export interface NewsAlertRow {
  chatId: number;
  topicId: number;
  kind: string;
  at: number;
  detail: string;
}

export interface ChatDefaults {
  language: Lang;
  digestHour: number;
  timezone: string;
  rsiMode: RsiMode;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  username TEXT,
  type TEXT NOT NULL DEFAULT 'supergroup',
  language TEXT NOT NULL,
  digest_hour INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  thread_id INTEGER,
  rsi_mode TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_digest_at INTEGER,
  last_evolve_at INTEGER,
  last_calibrated_at INTEGER,
  judge_notes TEXT NOT NULL DEFAULT '',
  improver_notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'group',
  report_chat_id INTEGER,
  reader_ref TEXT,
  reader_cursor INTEGER,
  reader_error TEXT
);
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id INTEGER,
  user_id INTEGER NOT NULL,
  date INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to INTEGER,
  reactions INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_by_date ON messages (chat_id, date);
CREATE TABLE IF NOT EXISTS optouts (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  genome_version INTEGER NOT NULL,
  json TEXT NOT NULL,
  metrics_json TEXT,
  critique_json TEXT,
  posted_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  posted_chat_id INTEGER
);
CREATE INDEX IF NOT EXISTS digests_by_chat ON digests (chat_id, kind, window_end);
CREATE TABLE IF NOT EXISTS votes (
  digest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (digest_id, user_id)
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  digest_id INTEGER,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS genomes (
  chat_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  parent INTEGER,
  playbook TEXT NOT NULL,
  operator TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  win_rate REAL,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  promoted_at INTEGER,
  PRIMARY KEY (chat_id, version)
);
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  champion_version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  report_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  ms INTEGER
);
CREATE INDEX IF NOT EXISTS activity_by_time ON activity (at);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  html TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
-- Private groups reached by an invite link (docs/private-groups.md). The hash is what lets anyone
-- in: it is never logged in full, and it is dropped 30 days after the row is done with.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  verdict TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'supergroup',
  members INTEGER,
  about TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '',
  peek_until INTEGER,
  chat_id INTEGER,
  peer TEXT,
  said TEXT,
  said_at INTEGER,
  opened_at INTEGER,
  joined_at INTEGER,
  checks INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_result TEXT NOT NULL DEFAULT '',
  next_check_at INTEGER,
  done_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_active_hash ON invites (hash)
  WHERE hash IS NOT NULL AND state NOT IN ('dismissed', 'expired', 'no-answer', 'link-dead', 'refused');
CREATE INDEX IF NOT EXISTS invites_due ON invites (state, next_check_at);
-- The account's own standing in a chat it joined: member, held for a check, removed.
CREATE TABLE IF NOT EXISTS memberships (
  chat_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  cause TEXT NOT NULL DEFAULT '',
  until_date INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  via_request INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER,
  history_from INTEGER,
  invite_id INTEGER,
  checked_at INTEGER NOT NULL,
  next_check_at INTEGER,
  checks_day TEXT NOT NULL DEFAULT '',
  recheck_count INTEGER NOT NULL DEFAULT 0
);
-- The news radar (news.ts): first-tier news sources, what they published, and what was flagged.
CREATE TABLE IF NOT EXISTS news_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  tier INTEGER NOT NULL DEFAULT 1,
  every_s INTEGER NOT NULL DEFAULT 120,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_fetch_at INTEGER,
  last_ok_at INTEGER,
  last_error TEXT,
  items_total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  link TEXT,
  published_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  backlog INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source_id, guid)
);
CREATE INDEX IF NOT EXISTS news_items_by_time ON news_items (published_at);
-- One row per escalation (a notification), so it fires once.
CREATE TABLE IF NOT EXISTS news_alerts (
  chat_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (chat_id, topic_id, kind)
);
`;

type Row = Record<string, unknown>;
type Param = number | string | null;

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class Store {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly clock: () => number;

  constructor(path: string, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.clock = clock;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;'); // the MCP server opens the same file
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adds columns introduced after a database was created. */
  private migrate(): void {
    const added: [string, string, string][] = [
      ['chats', 'kind', "TEXT NOT NULL DEFAULT 'group'"],
      ['chats', 'report_chat_id', 'INTEGER'],
      ['chats', 'reader_ref', 'TEXT'],
      ['chats', 'reader_cursor', 'INTEGER'],
      ['chats', 'reader_error', 'TEXT'],
      ['chats', 'reader_peer', 'TEXT'],
      ['chats', 'reader_origin', 'TEXT'],
      ['digests', 'posted_chat_id', 'INTEGER'],
      ['outbox', 'source_chat_id', 'INTEGER'],
    ];
    for (const [table, column, type] of added) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  private q(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
    const r = this.q(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  private get(sql: string, ...params: Param[]): Row | undefined {
    return this.q(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: Param[]): Row[] {
    return this.q(sql).all(...params) as Row[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── chats ────────────────────────────────────────────────────────────────

  private toChat(r: Row): ChatRow {
    return {
      chatId: num(r.chat_id),
      title: str(r.title),
      username: strOrNull(r.username),
      type: str(r.type),
      language: str(r.language) as Lang,
      digestHour: num(r.digest_hour),
      timezone: str(r.timezone),
      threadId: numOrNull(r.thread_id),
      rsiMode: str(r.rsi_mode) as RsiMode,
      enabled: num(r.enabled) === 1,
      lastDigestAt: numOrNull(r.last_digest_at),
      lastEvolveAt: numOrNull(r.last_evolve_at),
      lastCalibratedAt: numOrNull(r.last_calibrated_at),
      judgeNotes: str(r.judge_notes),
      improverNotes: str(r.improver_notes),
      createdAt: num(r.created_at),
      kind: (str(r.kind) || 'group') as ChatKind,
      reportChatId: numOrNull(r.report_chat_id),
      readerRef: strOrNull(r.reader_ref),
      readerCursor: numOrNull(r.reader_cursor),
      readerError: strOrNull(r.reader_error),
      readerPeer: strOrNull(r.reader_peer),
      readerOrigin: (strOrNull(r.reader_origin) as ChatRow['readerOrigin']) ?? null,
    };
  }

  /** Creates the chat on first sight (first digest at the next scheduled slot), refreshes title/username after. */
  upsertChat(c: { chatId: number; title: string; username: string | null; type: string }, defaults: ChatDefaults): ChatRow {
    const now = this.clock();
    this.run(
      `INSERT INTO chats (chat_id, title, username, type, language, digest_hour, timezone, rsi_mode, last_digest_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, type = excluded.type`,
      c.chatId,
      c.title,
      c.username,
      c.type,
      defaults.language,
      defaults.digestHour,
      defaults.timezone,
      defaults.rsiMode,
      now,
      now,
    );
    return this.getChat(c.chatId)!;
  }

  getChat(chatId: number): ChatRow | null {
    const r = this.get('SELECT * FROM chats WHERE chat_id = ?', chatId);
    return r ? this.toChat(r) : null;
  }

  listChats(onlyEnabled = true): ChatRow[] {
    return this.all(`SELECT * FROM chats ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY chat_id`).map((r) =>
      this.toChat(r),
    );
  }

  updateChat(
    chatId: number,
    patch: Partial<
      Pick<
        ChatRow,
        | 'language'
        | 'digestHour'
        | 'timezone'
        | 'threadId'
        | 'rsiMode'
        | 'enabled'
        | 'lastDigestAt'
        | 'lastEvolveAt'
        | 'lastCalibratedAt'
        | 'judgeNotes'
        | 'improverNotes'
        | 'kind'
        | 'reportChatId'
        | 'readerRef'
        | 'readerCursor'
        | 'readerError'
        | 'readerPeer'
        | 'readerOrigin'
      >
    >,
  ): void {
    const cols: Record<string, string> = {
      language: 'language',
      digestHour: 'digest_hour',
      timezone: 'timezone',
      threadId: 'thread_id',
      rsiMode: 'rsi_mode',
      enabled: 'enabled',
      lastDigestAt: 'last_digest_at',
      lastEvolveAt: 'last_evolve_at',
      lastCalibratedAt: 'last_calibrated_at',
      judgeNotes: 'judge_notes',
      improverNotes: 'improver_notes',
      kind: 'kind',
      reportChatId: 'report_chat_id',
      readerRef: 'reader_ref',
      readerCursor: 'reader_cursor',
      readerError: 'reader_error',
      readerPeer: 'reader_peer',
      readerOrigin: 'reader_origin',
    };
    for (const [key, value] of Object.entries(patch)) {
      const col = cols[key];
      if (!col || value === undefined) continue;
      const v = typeof value === 'boolean' ? (value ? 1 : 0) : (value as Param);
      this.run(`UPDATE chats SET ${col} = ? WHERE chat_id = ?`, v, chatId);
    }
  }

  /** Registers (or re-enables) a group or channel the reader account watches, reporting to `reportChatId`. */
  watchChat(
    c: { chatId: number; title: string; username: string | null; type: string; ref: string; peer?: string | null },
    reportChatId: number,
    threadId: number | null,
    defaults: ChatDefaults,
  ): ChatRow {
    this.upsertChat({ chatId: c.chatId, title: c.title, username: c.username, type: c.type }, defaults);
    this.updateChat(c.chatId, { kind: 'watched', reportChatId, threadId, readerRef: c.ref, enabled: true, readerError: null, ...(c.peer ? { readerPeer: c.peer } : {}) });
    return this.getChat(c.chatId)!;
  }

  /** Watched chats whose digests go to `reportChatId`, in the order they were added (that is what #1, #2… refer to). */
  sourcesReportingTo(reportChatId: number): ChatRow[] {
    return this.listChats(true)
      .filter((c) => c.kind === 'watched' && c.reportChatId === reportChatId)
      .sort((a, b) => a.createdAt - b.createdAt || a.title.localeCompare(b.title));
  }

  // ── users (stable per-chat aliases) ──────────────────────────────────────

  upsertUser(chatId: number, userId: number, displayName: string, username: string | null): UserRow {
    const existing = this.get('SELECT * FROM users WHERE chat_id = ? AND user_id = ?', chatId, userId);
    if (existing) {
      if (str(existing.display_name) !== displayName || strOrNull(existing.username) !== username) {
        this.run('UPDATE users SET display_name = ?, username = ? WHERE chat_id = ? AND user_id = ?', displayName, username, chatId, userId);
      }
      return { userId, alias: str(existing.alias), displayName, username };
    }
    const count = num(this.get('SELECT COUNT(*) AS n FROM users WHERE chat_id = ?', chatId)!.n);
    const alias = `U${count + 1}`;
    this.run('INSERT INTO users (chat_id, user_id, alias, display_name, username) VALUES (?, ?, ?, ?, ?)', chatId, userId, alias, displayName, username);
    return { userId, alias, displayName, username };
  }

  users(chatId: number): Map<number, UserRow> {
    const out = new Map<number, UserRow>();
    for (const r of this.all('SELECT * FROM users WHERE chat_id = ?', chatId)) {
      out.set(num(r.user_id), {
        userId: num(r.user_id),
        alias: str(r.alias),
        displayName: str(r.display_name),
        username: strOrNull(r.username),
      });
    }
    return out;
  }

  // ── messages ─────────────────────────────────────────────────────────────

  saveMessage(m: StoredMessage): void {
    this.run(
      `INSERT INTO messages (chat_id, message_id, thread_id, user_id, date, text, reply_to, reactions, edited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET text = excluded.text, edited = excluded.edited`,
      m.chatId,
      m.messageId,
      m.threadId,
      m.userId,
      m.date,
      m.text,
      m.replyTo,
      m.reactions,
      m.edited ? 1 : 0,
    );
  }

  editMessage(chatId: number, messageId: number, text: string): boolean {
    return this.run('UPDATE messages SET text = ?, edited = 1 WHERE chat_id = ? AND message_id = ?', text, chatId, messageId).changes > 0;
  }

  setReactions(chatId: number, messageId: number, total: number): void {
    this.run('UPDATE messages SET reactions = ? WHERE chat_id = ? AND message_id = ?', Math.max(0, total), chatId, messageId);
  }

  addReactions(chatId: number, messageId: number, delta: number): void {
    this.run(
      'UPDATE messages SET reactions = MAX(0, reactions + ?) WHERE chat_id = ? AND message_id = ?',
      delta,
      chatId,
      messageId,
    );
  }

  messages(chatId: number, from: number, to: number): StoredMessage[] {
    return this.all(
      'SELECT * FROM messages WHERE chat_id = ? AND date >= ? AND date < ? ORDER BY date, message_id',
      chatId,
      from,
      to,
    ).map((r) => ({
      chatId: num(r.chat_id),
      messageId: num(r.message_id),
      threadId: numOrNull(r.thread_id),
      userId: num(r.user_id),
      date: num(r.date),
      text: str(r.text),
      replyTo: numOrNull(r.reply_to),
      reactions: num(r.reactions),
      edited: num(r.edited) === 1,
    }));
  }

  /** How many messages a chat has in a period, and the oldest one's date (how much of the period is covered). */
  messageSpan(chatId: number, from: number, to: number): { count: number; oldest: number | null } {
    const r = this.get('SELECT COUNT(*) AS n, MIN(date) AS oldest FROM messages WHERE chat_id = ? AND date >= ? AND date < ?', chatId, from, to);
    return { count: num(r?.n ?? 0), oldest: numOrNull(r?.oldest) };
  }

  countMessages(chatId: number, from: number, to: number): number {
    return num(this.get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND date >= ? AND date < ?', chatId, from, to)!.n);
  }

  /** Retention: raw messages and unposted shadow digests older than the cutoff are deleted. */
  purgeBefore(cutoff: number): { messages: number; shadows: number } {
    const messages = this.run('DELETE FROM messages WHERE date < ?', cutoff).changes;
    const shadows = this.run("DELETE FROM digests WHERE kind = 'shadow' AND window_end < ?", cutoff).changes;
    return { messages, shadows };
  }

  // ── opt-out ──────────────────────────────────────────────────────────────

  optOut(chatId: number, userId: number): number {
    return this.transaction(() => {
      this.run('INSERT OR IGNORE INTO optouts (chat_id, user_id, created_at) VALUES (?, ?, ?)', chatId, userId, this.clock());
      return this.run('DELETE FROM messages WHERE chat_id = ? AND user_id = ?', chatId, userId).changes;
    });
  }

  optIn(chatId: number, userId: number): boolean {
    return this.run('DELETE FROM optouts WHERE chat_id = ? AND user_id = ?', chatId, userId).changes > 0;
  }

  isOptedOut(chatId: number, userId: number): boolean {
    return this.get('SELECT 1 AS x FROM optouts WHERE chat_id = ? AND user_id = ?', chatId, userId) !== undefined;
  }

  // ── digests ──────────────────────────────────────────────────────────────

  private toDigest(r: Row): DigestRow {
    return {
      id: num(r.id),
      chatId: num(r.chat_id),
      kind: str(r.kind) as DigestKind,
      windowStart: num(r.window_start),
      windowEnd: num(r.window_end),
      genomeVersion: num(r.genome_version),
      digest: JSON.parse(str(r.json)) as Digest,
      metrics: r.metrics_json ? (JSON.parse(str(r.metrics_json)) as Metrics) : null,
      critique: r.critique_json ? (JSON.parse(str(r.critique_json)) as Critique) : null,
      postedIds: JSON.parse(str(r.posted_ids) || '[]') as number[],
      postedChatId: numOrNull(r.posted_chat_id),
      createdAt: num(r.created_at),
    };
  }

  saveDigest(d: {
    chatId: number;
    kind: DigestKind;
    windowStart: number;
    windowEnd: number;
    genomeVersion: number;
    digest: Digest;
    metrics: Metrics | null;
  }): number {
    return this.run(
      `INSERT INTO digests (chat_id, kind, window_start, window_end, genome_version, json, metrics_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      d.chatId,
      d.kind,
      d.windowStart,
      d.windowEnd,
      d.genomeVersion,
      JSON.stringify(d.digest),
      d.metrics ? JSON.stringify(d.metrics) : null,
      this.clock(),
    ).lastId;
  }

  digest(id: number): DigestRow | null {
    const r = this.get('SELECT * FROM digests WHERE id = ?', id);
    return r ? this.toDigest(r) : null;
  }

  setPosted(id: number, messageIds: number[], postedChatId: number | null = null): void {
    this.run('UPDATE digests SET posted_ids = ?, posted_chat_id = COALESCE(?, chat_id) WHERE id = ?', JSON.stringify(messageIds), postedChatId, id);
  }

  setCritique(id: number, critique: Critique): void {
    this.run('UPDATE digests SET critique_json = ? WHERE id = ?', JSON.stringify(critique), id);
  }

  /** Most recent production digests, newest first. */
  productionDigests(chatId: number, limit: number): DigestRow[] {
    return this.all(
      "SELECT * FROM digests WHERE chat_id = ? AND kind = 'production' ORDER BY window_end DESC, id DESC LIMIT ?",
      chatId,
      limit,
    ).map((r) => this.toDigest(r));
  }

  latestPosted(chatId: number): DigestRow | null {
    const r = this.get(
      "SELECT * FROM digests WHERE chat_id = ? AND kind != 'shadow' AND posted_ids != '[]' ORDER BY id DESC LIMIT 1",
      chatId,
    );
    return r ? this.toDigest(r) : null;
  }

  /** The digest one of whose messages is `messageId` in `postedChatId` (a group, or a report chat). */
  digestByPostedMessage(postedChatId: number, messageId: number): DigestRow | null {
    const rows = this.all(
      "SELECT * FROM digests WHERE COALESCE(posted_chat_id, chat_id) = ? AND kind != 'shadow' AND posted_ids != '[]' ORDER BY id DESC LIMIT 200",
      postedChatId,
    );
    for (const r of rows) {
      const d = this.toDigest(r);
      if (d.postedIds.includes(messageId)) return d;
    }
    return null;
  }

  /** A digest of exactly this window written by this genome version (production or shadow). */
  digestFor(chatId: number, windowStart: number, windowEnd: number, version: number): DigestRow | null {
    const r = this.get(
      `SELECT * FROM digests WHERE chat_id = ? AND window_start = ? AND window_end = ? AND genome_version = ? AND kind != 'manual'
       ORDER BY CASE kind WHEN 'production' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
      chatId,
      windowStart,
      windowEnd,
      version,
    );
    return r ? this.toDigest(r) : null;
  }

  /** Posted digests in a period, for recurring-item history. */
  postedDigestsSince(chatId: number, since: number): DigestRow[] {
    return this.all(
      "SELECT * FROM digests WHERE chat_id = ? AND kind = 'production' AND window_end > ? ORDER BY window_end, id",
      chatId,
      since,
    ).map((r) => this.toDigest(r));
  }

  // ── reader feedback ──────────────────────────────────────────────────────

  /** Sets (or clears, if the same value is sent again) a reader's vote. Returns the stored value. */
  vote(digestId: number, userId: number, value: 1 | -1): 0 | 1 | -1 {
    const prev = this.get('SELECT value FROM votes WHERE digest_id = ? AND user_id = ?', digestId, userId);
    if (prev && num(prev.value) === value) {
      this.run('DELETE FROM votes WHERE digest_id = ? AND user_id = ?', digestId, userId);
      return 0;
    }
    this.run(
      `INSERT INTO votes (digest_id, user_id, value, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (digest_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
      digestId,
      userId,
      value,
      this.clock(),
    );
    return value;
  }

  tally(digestId: number): { up: number; down: number } {
    const r = this.get(
      'SELECT SUM(CASE WHEN value > 0 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN value < 0 THEN 1 ELSE 0 END) AS down FROM votes WHERE digest_id = ?',
      digestId,
    )!;
    return { up: num(r.up ?? 0), down: num(r.down ?? 0) };
  }

  /** Vote totals over the first `firstN` posted digests written by one genome version (its probation). */
  tallyForVersion(chatId: number, version: number, firstN = 1_000_000): { up: number; down: number; digests: number } {
    const r = this.get(
      `WITH d AS (
         SELECT id FROM digests
         WHERE chat_id = ? AND genome_version = ? AND kind != 'shadow' AND posted_ids != '[]'
         ORDER BY id LIMIT ?
       )
       SELECT (SELECT COUNT(*) FROM d) AS digests,
              SUM(CASE WHEN v.value > 0 THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN v.value < 0 THEN 1 ELSE 0 END) AS down
       FROM votes v WHERE v.digest_id IN (SELECT id FROM d)`,
      chatId,
      version,
      firstN,
    )!;
    return { up: num(r.up ?? 0), down: num(r.down ?? 0), digests: num(r.digests ?? 0) };
  }

  addFeedback(chatId: number, digestId: number | null, userId: number, text: string): void {
    this.run(
      'INSERT INTO feedback (chat_id, digest_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)',
      chatId,
      digestId,
      userId,
      text,
      this.clock(),
    );
  }

  feedbackSince(chatId: number, since: number): FeedbackRow[] {
    return this.all('SELECT * FROM feedback WHERE chat_id = ? AND created_at > ? ORDER BY id', chatId, since).map((r) => ({
      digestId: numOrNull(r.digest_id),
      userId: num(r.user_id),
      text: str(r.text),
      createdAt: num(r.created_at),
    }));
  }

  votesSince(chatId: number, since: number): number {
    return num(
      this.get(
        'SELECT COUNT(*) AS n FROM votes v JOIN digests d ON d.id = v.digest_id WHERE d.chat_id = ? AND v.created_at > ?',
        chatId,
        since,
      )!.n,
    );
  }

  // ── genomes (the playbook lineage) ───────────────────────────────────────

  private toGenome(r: Row): GenomeRow {
    return {
      chatId: num(r.chat_id),
      version: num(r.version),
      parent: numOrNull(r.parent),
      playbook: str(r.playbook),
      operator: str(r.operator),
      rationale: str(r.rationale),
      status: str(r.status) as GenomeStatus,
      winRate: r.win_rate === null || r.win_rate === undefined ? null : Number(r.win_rate),
      summary: str(r.summary),
      createdAt: num(r.created_at),
      promotedAt: numOrNull(r.promoted_at),
    };
  }

  /** The current champion; seeds version 0 with the given playbook on first use. */
  champion(chatId: number, seedPlaybook: string): GenomeRow {
    const r = this.get("SELECT * FROM genomes WHERE chat_id = ? AND status = 'champion' ORDER BY version DESC LIMIT 1", chatId);
    if (r) return this.toGenome(r);
    const now = this.clock();
    this.run(
      `INSERT INTO genomes (chat_id, version, parent, playbook, operator, rationale, status, created_at, promoted_at)
       VALUES (?, 0, NULL, ?, 'seed', 'Hand-written starting playbook.', 'champion', ?, ?)`,
      chatId,
      seedPlaybook,
      now,
      now,
    );
    return this.genome(chatId, 0)!;
  }

  genome(chatId: number, version: number): GenomeRow | null {
    const r = this.get('SELECT * FROM genomes WHERE chat_id = ? AND version = ?', chatId, version);
    return r ? this.toGenome(r) : null;
  }

  nextVersion(chatId: number): number {
    return num(this.get('SELECT COALESCE(MAX(version), -1) + 1 AS v FROM genomes WHERE chat_id = ?', chatId)!.v);
  }

  addGenome(g: Omit<GenomeRow, 'createdAt' | 'promotedAt'>): void {
    this.run(
      `INSERT INTO genomes (chat_id, version, parent, playbook, operator, rationale, status, win_rate, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.chatId,
      g.version,
      g.parent,
      g.playbook,
      g.operator,
      g.rationale,
      g.status,
      g.winRate,
      g.summary,
      this.clock(),
    );
  }

  addGenomeResult(chatId: number, version: number, winRate: number, summary: string): void {
    this.run('UPDATE genomes SET win_rate = ?, summary = ? WHERE chat_id = ? AND version = ?', winRate, summary, chatId, version);
  }

  setGenomeStatus(chatId: number, version: number, status: GenomeStatus): void {
    this.run('UPDATE genomes SET status = ? WHERE chat_id = ? AND version = ?', status, chatId, version);
  }

  /** Makes `version` the only champion; the previous champion becomes `previousStatus`. */
  crown(chatId: number, version: number, previousStatus: GenomeStatus = 'retired'): void {
    this.transaction(() => {
      this.run("UPDATE genomes SET status = ? WHERE chat_id = ? AND status = 'champion'", previousStatus, chatId);
      this.run("UPDATE genomes SET status = 'champion', promoted_at = ? WHERE chat_id = ? AND version = ?", this.clock(), chatId, version);
    });
  }

  genomes(chatId: number, limit = 20): GenomeRow[] {
    return this.all('SELECT * FROM genomes WHERE chat_id = ? ORDER BY version DESC LIMIT ?', chatId, limit).map((r) =>
      this.toGenome(r),
    );
  }

  pendingGenome(chatId: number): GenomeRow | null {
    const r = this.get("SELECT * FROM genomes WHERE chat_id = ? AND status = 'pending' ORDER BY version DESC LIMIT 1", chatId);
    return r ? this.toGenome(r) : null;
  }

  // ── generations (one per evolution run) ──────────────────────────────────

  addGeneration(g: Omit<GenerationRow, 'id' | 'createdAt'>): number {
    return this.run(
      'INSERT INTO generations (chat_id, created_at, champion_version, decision, report_json, cost_usd) VALUES (?, ?, ?, ?, ?, ?)',
      g.chatId,
      this.clock(),
      g.championVersion,
      g.decision,
      JSON.stringify(g.report),
      g.costUsd,
    ).lastId;
  }

  generations(chatId: number, limit = 10): GenerationRow[] {
    return this.all('SELECT * FROM generations WHERE chat_id = ? ORDER BY id DESC LIMIT ?', chatId, limit).map((r) => ({
      id: num(r.id),
      chatId: num(r.chat_id),
      createdAt: num(r.created_at),
      championVersion: num(r.champion_version),
      decision: str(r.decision),
      report: JSON.parse(str(r.report_json)),
      costUsd: Number(r.cost_usd),
    }));
  }

  // ── LLM usage ────────────────────────────────────────────────────────────

  addUsage(u: UsageRow): void {
    this.run(
      `INSERT INTO usage (chat_id, role, model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.chatId,
      u.role,
      u.model,
      u.inputTokens,
      u.outputTokens,
      u.cacheRead,
      u.cacheWrite,
      u.costUsd,
      this.clock(),
    );
  }

  costSince(chatId: number, since: number): { digest: number; rsi: number } {
    const rows = this.all(
      "SELECT CASE WHEN role IN ('digest', 'merge') THEN 'digest' ELSE 'rsi' END AS k, SUM(COALESCE(cost_usd, 0)) AS c FROM usage WHERE chat_id = ? AND created_at > ? GROUP BY k",
      chatId,
      since,
    );
    const out = { digest: 0, rsi: 0 };
    for (const r of rows) out[str(r.k) as 'digest' | 'rsi'] = Number(r.c);
    return out;
  }

  usageTotals(since: number): { calls: number; costUsd: number; inputTokens: number; outputTokens: number } {
    const r = this.get(
      'SELECT COUNT(*) AS n, SUM(COALESCE(cost_usd, 0)) AS c, SUM(input_tokens + cache_read + cache_write) AS i, SUM(output_tokens) AS o FROM usage WHERE created_at > ?',
      since,
    );
    return { calls: num(r?.n ?? 0), costUsd: Number(r?.c ?? 0), inputTokens: num(r?.i ?? 0), outputTokens: num(r?.o ?? 0) };
  }

  // ── activity (what the service did) ──────────────────────────────────────

  addActivity(a: Omit<ActivityRow, 'id' | 'at'> & { at?: number }): ActivityRow {
    const at = a.at ?? this.clock();
    const { lastId } = this.run(
      'INSERT INTO activity (at, actor, kind, method, target, detail, ok, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      at,
      a.actor,
      a.kind,
      a.method,
      a.target.slice(0, 200),
      a.detail.slice(0, 1000),
      a.ok ? 1 : 0,
      a.ms,
    );
    return { ...a, at, id: lastId, target: a.target.slice(0, 200), detail: a.detail.slice(0, 1000) };
  }

  private toActivity(r: Row): ActivityRow {
    return {
      id: num(r.id),
      at: num(r.at),
      actor: str(r.actor),
      kind: str(r.kind) as ActivityKind,
      method: str(r.method),
      target: str(r.target),
      detail: str(r.detail),
      ok: Boolean(r.ok),
      ms: numOrNull(r.ms),
    };
  }

  /** The newest `limit` rows (oldest first), or the rows after `afterId`. */
  activity(opts: { afterId?: number; limit?: number; kind?: ActivityKind } = {}): ActivityRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const where = ['id > ?'];
    const params: Param[] = [opts.afterId ?? 0];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    const rows = this.all(`SELECT * FROM activity WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params, limit);
    return rows.map((r) => this.toActivity(r)).reverse();
  }

  /** How many requests of each kind since `since`, and the last write. */
  activitySummary(since: number): { counts: Record<string, number>; lastWrite: ActivityRow | null; errors: number } {
    const counts: Record<string, number> = {};
    for (const r of this.all('SELECT kind, COUNT(*) AS n FROM activity WHERE at > ? GROUP BY kind', since)) counts[str(r.kind)] = num(r.n);
    const w = this.get("SELECT * FROM activity WHERE kind = 'write' ORDER BY id DESC LIMIT 1");
    const errors = num(this.get('SELECT COUNT(*) AS n FROM activity WHERE at > ? AND ok = 0', since)?.n ?? 0);
    return { counts, lastWrite: w ? this.toActivity(w) : null, errors };
  }

  pruneActivity(before: number): number {
    return this.run('DELETE FROM activity WHERE at < ?', before).changes;
  }

  addOutbox(chatId: number, html: string, delivered: boolean, sourceChatId: number | null = null): number {
    return this.run('INSERT INTO outbox (at, chat_id, html, delivered, source_chat_id) VALUES (?, ?, ?, ?, ?)', this.clock(), chatId, html, delivered ? 1 : 0, sourceChatId).lastId;
  }

  outbox(limit = 50): OutboxRow[] {
    return this.all('SELECT * FROM outbox ORDER BY id DESC LIMIT ?', limit).map((r) => ({
      id: num(r.id),
      at: num(r.at),
      chatId: num(r.chat_id),
      html: str(r.html),
      delivered: Boolean(r.delivered),
      sourceChatId: numOrNull(r.source_chat_id),
    }));
  }

  /** Recent digests of every chat, newest first (for the console). */
  recentDigests(limit = 30): DigestRow[] {
    return this.all("SELECT * FROM digests WHERE kind != 'shadow' ORDER BY id DESC LIMIT ?", limit).map((r) => this.toDigest(r));
  }

  /**
   * Message count per chat since `since`, and the newest stored message date. One query per known
   * chat, each a range on the (chat_id, date) index: no scan of everything kept.
   */
  messageStats(since: number): Map<number, { count: number; newest: number | null; people: number }> {
    const out = new Map<number, { count: number; newest: number | null; people: number }>();
    for (const c of this.all('SELECT chat_id FROM chats')) {
      const chatId = num(c.chat_id);
      const r = this.get('SELECT COUNT(*) AS n, MAX(date) AS newest, COUNT(DISTINCT user_id) AS people FROM messages WHERE chat_id = ? AND date > ?', chatId, since);
      if (r && num(r.n) > 0) out.set(chatId, { count: num(r.n), newest: numOrNull(r.newest), people: num(r.people) });
    }
    return out;
  }

  /** Messages per chat per time bucket since `since`: chat → (floor(date / bucketS) → count). Indexed, per chat. */
  messageBuckets(since: number, bucketS: number): Map<number, Map<number, number>> {
    const out = new Map<number, Map<number, number>>();
    for (const c of this.all('SELECT chat_id FROM chats')) {
      const chatId = num(c.chat_id);
      const m = new Map<number, number>();
      for (const r of this.all('SELECT CAST(date / ? AS INTEGER) AS b, COUNT(*) AS n FROM messages WHERE chat_id = ? AND date >= ? GROUP BY b', bucketS, chatId, since)) {
        m.set(num(r.b), num(r.n));
      }
      if (m.size) out.set(chatId, m);
    }
    return out;
  }

  /**
   * How long new messages took to reach the store, newest first: for each "stored" event since
   * `since`, the time from the newest message it stored being posted to it being stored.
   */
  captureLags(since: number, limit: number): { at: number; chatId: number; lag: number }[] {
    // The event names its chat by title: a title two chats share (a channel and its discussion
    // group, often) says nothing about which one, so it is left out rather than guessed.
    const byTitle = new Map<string, number | null>();
    for (const c of this.listChats(false)) byTitle.set(c.title, byTitle.has(c.title) ? null : c.chatId);
    const out: { at: number; chatId: number; lag: number }[] = [];
    for (const r of this.all("SELECT at, target FROM activity WHERE method = 'stored' AND at >= ? ORDER BY id DESC LIMIT ?", since, limit)) {
      const chatId = byTitle.get(String(r.target));
      if (chatId === undefined || chatId === null) continue;
      const at = num(r.at);
      const newest = numOrNull(this.get('SELECT MAX(date) AS d FROM messages WHERE chat_id = ? AND date <= ?', chatId, at)?.d);
      if (newest !== null) out.push({ at, chatId, lag: at - newest });
    }
    return out;
  }

  // ── storage: what is kept, and clearing it ───────────────────────────────

  storageCounts(): { messages: number; sources: number; people: number; activity: number; digests: number; outbox: number; news: number } {
    const n = (sql: string) => num(this.get(sql)?.n ?? 0);
    return {
      messages: n('SELECT COUNT(*) AS n FROM messages'),
      sources: n('SELECT COUNT(DISTINCT chat_id) AS n FROM messages'),
      people: n('SELECT COUNT(*) AS n FROM users'),
      activity: n('SELECT COUNT(*) AS n FROM activity'),
      digests: n('SELECT COUNT(*) AS n FROM digests'),
      outbox: n('SELECT COUNT(*) AS n FROM outbox'),
      news: n('SELECT COUNT(*) AS n FROM news_items'),
    };
  }

  /**
   * Deletes what has been collected, for good: messages (and the people named in them), the
   * activity log, digests and outgoing messages, as chosen. Keeps the sources, their switches and
   * cursors (so nothing is downloaded again), settings, and the self-improving playbook. Then
   * rewrites the database file, so the deleted rows do not linger in free pages or the WAL.
   */
  clearStored(what: { messages?: boolean; activity?: boolean; digests?: boolean }): { deleted: Record<string, number>; compacted: boolean } {
    const deleted: Record<string, number> = {};
    this.transaction(() => {
      if (what.messages) {
        deleted.messages = this.run('DELETE FROM messages').changes;
        deleted.people = this.run('DELETE FROM users').changes;
        // The news radar's record of what it saw and flagged goes too; feeds are read afresh.
        deleted.news = this.run('DELETE FROM news_items').changes;
        this.run('DELETE FROM news_alerts');
        this.run('UPDATE news_sources SET etag = NULL, last_modified = NULL, last_ok_at = NULL');
      }
      if (what.activity) deleted.activity = this.run('DELETE FROM activity').changes;
      if (what.digests) {
        deleted.digests = this.run('DELETE FROM digests').changes;
        deleted.votes = this.run('DELETE FROM votes').changes;
        deleted.outbox = this.run('DELETE FROM outbox').changes;
      }
    });
    let compacted = true;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db.exec('VACUUM;');
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      compacted = false; // another process held the file: the rows are gone, the space comes back later
    }
    return { deleted, compacted };
  }

  // ── invites and memberships (private groups, docs/private-groups.md) ─────

  private toInvite(r: Row): InviteRow {
    return {
      id: num(r.id),
      hash: strOrNull(r.hash),
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      origin: str(r.origin) as InviteRow['origin'],
      state: str(r.state),
      verdict: str(r.verdict),
      title: str(r.title),
      kind: str(r.kind),
      members: numOrNull(r.members),
      about: str(r.about),
      flags: str(r.flags).split(',').filter(Boolean),
      peekUntil: numOrNull(r.peek_until),
      chatId: numOrNull(r.chat_id),
      peer: strOrNull(r.peer),
      said: (strOrNull(r.said) as InviteRow['said']) ?? null,
      saidAt: numOrNull(r.said_at),
      openedAt: numOrNull(r.opened_at),
      joinedAt: numOrNull(r.joined_at),
      checks: num(r.checks),
      lastCheckAt: numOrNull(r.last_check_at),
      lastResult: str(r.last_result),
      nextCheckAt: numOrNull(r.next_check_at),
      doneAt: numOrNull(r.done_at),
      note: str(r.note),
    };
  }

  private static readonly INVITE_COLS: Record<string, string> = {
    hash: 'hash',
    origin: 'origin',
    state: 'state',
    verdict: 'verdict',
    title: 'title',
    kind: 'kind',
    members: 'members',
    about: 'about',
    flags: 'flags',
    peekUntil: 'peek_until',
    chatId: 'chat_id',
    peer: 'peer',
    said: 'said',
    saidAt: 'said_at',
    openedAt: 'opened_at',
    joinedAt: 'joined_at',
    checks: 'checks',
    lastCheckAt: 'last_check_at',
    lastResult: 'last_result',
    nextCheckAt: 'next_check_at',
    doneAt: 'done_at',
    note: 'note',
  };

  addInvite(i: Pick<InviteRow, 'hash' | 'origin' | 'state' | 'verdict'> & Partial<InviteRow>): InviteRow {
    const now = this.clock();
    const { lastId } = this.run('INSERT INTO invites (hash, created_at, updated_at, origin, state, verdict) VALUES (?, ?, ?, ?, ?, ?)', i.hash, now, now, i.origin, i.state, i.verdict);
    const { hash: _h, origin: _o, state: _s, verdict: _v, id: _i, createdAt: _c, updatedAt: _u, ...rest } = i;
    this.updateInvite(lastId, rest);
    return this.getInvite(lastId)!;
  }

  getInvite(id: number): InviteRow | null {
    const r = this.get('SELECT * FROM invites WHERE id = ?', id);
    return r ? this.toInvite(r) : null;
  }

  /** The row still following this link, if any (not dismissed, expired or otherwise done with). */
  inviteByHash(hash: string): InviteRow | null {
    const r = this.get("SELECT * FROM invites WHERE hash = ? AND state NOT IN ('dismissed', 'expired', 'no-answer', 'link-dead', 'refused') ORDER BY id DESC LIMIT 1", hash);
    return r ? this.toInvite(r) : null;
  }

  /** The newest row for this link, whatever its state (a dead link looked at again). */
  latestInvite(hash: string): InviteRow | null {
    const r = this.get('SELECT * FROM invites WHERE hash = ? ORDER BY id DESC LIMIT 1', hash);
    return r ? this.toInvite(r) : null;
  }

  updateInvite(id: number, patch: Partial<Omit<InviteRow, 'id' | 'createdAt' | 'updatedAt'>>): void {
    for (const [key, value] of Object.entries(patch)) {
      const col = Store.INVITE_COLS[key];
      if (!col || value === undefined) continue;
      const v = Array.isArray(value) ? value.join(',') : typeof value === 'boolean' ? (value ? 1 : 0) : (value as Param);
      this.run(`UPDATE invites SET ${col} = ? WHERE id = ?`, v, id);
    }
    this.run('UPDATE invites SET updated_at = ? WHERE id = ?', this.clock(), id);
  }

  /** Newest first: everything still going, and what ended in the last `recentDays` days. */
  invites(recentDays = 7): InviteRow[] {
    const since = this.clock() - recentDays * 86_400;
    return this.all('SELECT * FROM invites WHERE done_at IS NULL OR done_at > ? ORDER BY id DESC LIMIT 100', since).map((r) => this.toInvite(r));
  }

  dueInvites(now: number): InviteRow[] {
    return this.all("SELECT * FROM invites WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND state IN ('requested', 'owner-opened', 'previewed', 'link-dead') AND hash IS NOT NULL ORDER BY next_check_at", now).map((r) =>
      this.toInvite(r),
    );
  }

  /** Forgets invite hashes 30 days after a row is done with, and the rows themselves after 90. */
  pruneInvites(now: number): number {
    const a = this.run('UPDATE invites SET hash = NULL WHERE hash IS NOT NULL AND done_at IS NOT NULL AND done_at < ?', now - 30 * 86_400).changes;
    const b = this.run('DELETE FROM invites WHERE done_at IS NOT NULL AND done_at < ?', now - 90 * 86_400).changes;
    return a + b;
  }

  private toMembership(r: Row): MembershipRow {
    return {
      chatId: num(r.chat_id),
      state: str(r.state),
      cause: str(r.cause),
      untilDate: numOrNull(r.until_date),
      detail: str(r.detail),
      viaRequest: num(r.via_request) === 1,
      joinedAt: numOrNull(r.joined_at),
      historyFrom: numOrNull(r.history_from),
      inviteId: numOrNull(r.invite_id),
      checkedAt: num(r.checked_at),
      nextCheckAt: numOrNull(r.next_check_at),
      checksDay: str(r.checks_day),
      recheckCount: num(r.recheck_count),
    };
  }

  private static readonly MEMBERSHIP_COLS: Record<string, string> = {
    state: 'state',
    cause: 'cause',
    untilDate: 'until_date',
    detail: 'detail',
    viaRequest: 'via_request',
    joinedAt: 'joined_at',
    historyFrom: 'history_from',
    inviteId: 'invite_id',
    checkedAt: 'checked_at',
    nextCheckAt: 'next_check_at',
    checksDay: 'checks_day',
    recheckCount: 'recheck_count',
  };

  setMembership(chatId: number, patch: Partial<Omit<MembershipRow, 'chatId'>>): MembershipRow {
    if (!this.get('SELECT 1 AS x FROM memberships WHERE chat_id = ?', chatId)) {
      this.run('INSERT INTO memberships (chat_id, state, checked_at) VALUES (?, ?, ?)', chatId, patch.state ?? 'unknown', patch.checkedAt ?? this.clock());
    }
    for (const [key, value] of Object.entries(patch)) {
      const col = Store.MEMBERSHIP_COLS[key];
      if (!col || value === undefined) continue;
      const v = typeof value === 'boolean' ? (value ? 1 : 0) : (value as Param);
      this.run(`UPDATE memberships SET ${col} = ? WHERE chat_id = ?`, v, chatId);
    }
    return this.membership(chatId)!;
  }

  membership(chatId: number): MembershipRow | null {
    const r = this.get('SELECT * FROM memberships WHERE chat_id = ?', chatId);
    return r ? this.toMembership(r) : null;
  }

  memberships(): MembershipRow[] {
    return this.all('SELECT * FROM memberships ORDER BY checked_at DESC').map((r) => this.toMembership(r));
  }

  dueMemberships(now: number): MembershipRow[] {
    return this.all('SELECT * FROM memberships WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at', now).map((r) => this.toMembership(r));
  }

  // ── news radar ───────────────────────────────────────────────────────────

  private toNewsSource(r: Row): NewsSourceRow {
    return {
      id: str(r.id),
      kind: str(r.kind) as NewsSourceRow['kind'],
      name: str(r.name),
      url: strOrNull(r.url),
      tier: num(r.tier),
      everyS: num(r.every_s),
      enabled: num(r.enabled) === 1,
      builtin: num(r.builtin) === 1,
      etag: strOrNull(r.etag),
      lastModified: strOrNull(r.last_modified),
      lastFetchAt: numOrNull(r.last_fetch_at),
      lastOkAt: numOrNull(r.last_ok_at),
      lastError: strOrNull(r.last_error),
      itemsTotal: num(r.items_total),
      createdAt: num(r.created_at),
    };
  }

  /** Adds a source if it is not there yet (a builtin one keeps the owner's switch and fetch state). */
  ensureNewsSource(s: Pick<NewsSourceRow, 'id' | 'kind' | 'name' | 'url' | 'tier' | 'everyS'> & { builtin?: boolean; enabled?: boolean }): NewsSourceRow {
    this.run(
      `INSERT INTO news_sources (id, kind, name, url, tier, every_s, enabled, builtin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, tier = excluded.tier, every_s = excluded.every_s`,
      s.id,
      s.kind,
      s.name,
      s.url,
      s.tier,
      s.everyS,
      s.enabled === false ? 0 : 1,
      s.builtin ? 1 : 0,
      this.clock(),
    );
    return this.newsSource(s.id)!;
  }

  newsSource(id: string): NewsSourceRow | null {
    const r = this.get('SELECT * FROM news_sources WHERE id = ?', id);
    return r ? this.toNewsSource(r) : null;
  }

  newsSources(): NewsSourceRow[] {
    return this.all('SELECT * FROM news_sources ORDER BY tier, builtin DESC, name').map((r) => this.toNewsSource(r));
  }

  updateNewsSource(id: string, patch: Partial<Pick<NewsSourceRow, 'enabled' | 'etag' | 'lastModified' | 'lastFetchAt' | 'lastOkAt' | 'lastError' | 'itemsTotal' | 'name' | 'tier' | 'everyS'>>): void {
    const cols: Record<string, string> = { enabled: 'enabled', etag: 'etag', lastModified: 'last_modified', lastFetchAt: 'last_fetch_at', lastOkAt: 'last_ok_at', lastError: 'last_error', itemsTotal: 'items_total', name: 'name', tier: 'tier', everyS: 'every_s' };
    for (const [key, value] of Object.entries(patch)) {
      const col = cols[key];
      if (!col || value === undefined) continue;
      this.run(`UPDATE news_sources SET ${col} = ? WHERE id = ?`, typeof value === 'boolean' ? (value ? 1 : 0) : (value as Param), id);
    }
  }

  removeNewsSource(id: string): void {
    this.transaction(() => {
      this.run('DELETE FROM news_items WHERE source_id = ?', id);
      this.run('DELETE FROM news_sources WHERE id = ?', id);
    });
  }

  private toNewsItem(r: Row): NewsItemRow {
    return {
      id: num(r.id),
      sourceId: str(r.source_id),
      guid: str(r.guid),
      title: str(r.title),
      summary: str(r.summary),
      link: strOrNull(r.link),
      publishedAt: num(r.published_at),
      seenAt: num(r.seen_at),
      backlog: num(r.backlog) === 1,
    };
  }

  /** Stores an item unless this source already has it. Returns the new row, or null when it was known. */
  addNewsItem(i: Omit<NewsItemRow, 'id'>): NewsItemRow | null {
    const r = this.run(
      'INSERT OR IGNORE INTO news_items (source_id, guid, title, summary, link, published_at, seen_at, backlog) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      i.sourceId,
      i.guid,
      i.title,
      i.summary,
      i.link,
      i.publishedAt,
      i.seenAt,
      i.backlog ? 1 : 0,
    );
    return r.changes > 0 ? { ...i, id: r.lastId } : null;
  }

  newsItems(since: number): NewsItemRow[] {
    return this.all('SELECT * FROM news_items WHERE published_at >= ? ORDER BY published_at, id', since).map((r) => this.toNewsItem(r));
  }

  newsItemCounts(since: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.all('SELECT source_id, COUNT(*) AS n FROM news_items WHERE published_at >= ? GROUP BY source_id', since)) out.set(str(r.source_id), num(r.n));
    return out;
  }

  /** Publish-to-seen delays (seconds) of a source's recent non-backlog items, newest first. */
  newsDelays(sourceId: string, limit = 20): number[] {
    return this.all('SELECT seen_at - published_at AS d FROM news_items WHERE source_id = ? AND backlog = 0 ORDER BY id DESC LIMIT ?', sourceId, limit).map((r) => num(r.d));
  }

  addNewsAlert(a: NewsAlertRow): boolean {
    return this.run('INSERT OR IGNORE INTO news_alerts (chat_id, topic_id, kind, at, detail) VALUES (?, ?, ?, ?, ?)', a.chatId, a.topicId, a.kind, a.at, a.detail).changes > 0;
  }

  newsAlerts(since: number): NewsAlertRow[] {
    return this.all('SELECT * FROM news_alerts WHERE at >= ? ORDER BY at DESC LIMIT 200', since).map((r) => ({ chatId: num(r.chat_id), topicId: num(r.topic_id), kind: str(r.kind), at: num(r.at), detail: str(r.detail) }));
  }

  /** Messages of a group naming any of these forms (a coarse LIKE prefilter; the caller checks each). */
  messagesLike(chatId: number, from: number, to: number, forms: string[]): { text: string }[] {
    if (forms.length === 0) return [];
    const like = forms.map(() => 'text LIKE ?').join(' OR ');
    return this.db
      .prepare(`SELECT text FROM messages WHERE chat_id = ? AND date >= ? AND date < ? AND (${like})`)
      .all(chatId, from, to, ...forms.map((f) => `%${f.replace(/[%_\\]/g, '')}%`)) as { text: string }[];
  }

  pruneNews(before: number): number {
    const a = this.run('DELETE FROM news_items WHERE published_at < ?', before).changes;
    const b = this.run('DELETE FROM news_alerts WHERE at < ?', before).changes;
    return a + b;
  }

  // ── key/value ────────────────────────────────────────────────────────────

  getKv(key: string): string | null {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key);
    return r ? str(r.value) : null;
  }

  setKv(key: string, value: string): void {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
}
