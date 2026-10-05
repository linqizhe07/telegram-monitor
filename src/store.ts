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
}

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
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
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
    this.db.exec(SCHEMA);
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
    };
    for (const [key, value] of Object.entries(patch)) {
      const col = cols[key];
      if (!col || value === undefined) continue;
      const v = typeof value === 'boolean' ? (value ? 1 : 0) : (value as Param);
      this.run(`UPDATE chats SET ${col} = ? WHERE chat_id = ?`, v, chatId);
    }
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

  setPosted(id: number, messageIds: number[]): void {
    this.run('UPDATE digests SET posted_ids = ? WHERE id = ?', JSON.stringify(messageIds), id);
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

  digestByPostedMessage(chatId: number, messageId: number): DigestRow | null {
    const rows = this.all(
      "SELECT * FROM digests WHERE chat_id = ? AND kind != 'shadow' AND posted_ids != '[]' ORDER BY id DESC LIMIT 60",
      chatId,
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

  // ── key/value ────────────────────────────────────────────────────────────

  getKv(key: string): string | null {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key);
    return r ? str(r.value) : null;
  }

  setKv(key: string, value: string): void {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
}
