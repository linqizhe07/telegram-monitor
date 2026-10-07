// The console: a local web page that shows what the service is doing, live. It binds to
// 127.0.0.1 only, answers only requests addressed to that host (no DNS rebinding), and its
// actions need a per-run token (no cross-site requests). There are two tokens: the page's, good
// for every action, and the one left for local tools (Claude's MCP server), good only for the few
// actions those tools use. So nothing Claude reads (other people's messages) can steer it into
// confirming a join, clearing storage or changing settings. What Claude does through its token is
// recorded as Claude's (actor "claude", and the app it came from), never as the owner's.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TelegramClient as GramClient } from 'telegram';
import type { Activity } from '../activity.ts';
import { clientLabel } from '../agent-views.ts';
import type { Config } from '../config.ts';
import { denoise, formatSignal } from '../denoise.ts';
import { digestFolders } from '../digest-folders.ts';
import type { Discovery } from '../discover.ts';
import { inviteHash } from '../invite-rules.ts';
import type { InviteTracker } from '../invites.ts';
import type { NewsRadar } from '../news.ts';
import { clean, type Notifier } from '../notify.ts';
import { probe, type ProbeResult } from '../probe.ts';
import { parseRef, withTimeout, type Reader } from '../reader.ts';
import type { ActivityRow, Store } from '../store.ts';
import { lastSlot } from '../transcript.ts';

export interface ConsoleDeps {
  store: Store;
  activity: Activity;
  config: Config;
  port: number;
  now: () => number;
  log: (line: string) => void;
  startedAt: number;
  account: { name: string; id: string; raw: GramClient; state?: () => { state: 'online' | 'offline'; since: number }; pushes?: () => { since: number; total: number; messages: number; kinds: Record<string, number> } } | null;
  reader: Reader | null;
  bot: { username: string } | null;
  claude: { ready: boolean; model: string };
  /** Asks the engine for a digest now; resolves with its outcome. */
  digestNow?: (chatId: number) => Promise<string>;
  /**
   * Where to leave {url, token, pid} (mode 600) while running, so local tools (the MCP server for
   * Claude) can ask the running service instead of opening a second Telegram connection.
   */
  handoffFile?: string;
  /** Private groups reached by invite links (null: not signed in). */
  invites?: InviteTracker | null;
  /** macOS notifications (for the test button). */
  notifier?: Notifier | null;
  /** The news radar (keywords of the day from first-tier sources, matched against the groups). */
  news?: NewsRadar | null;
  /** How often rows other processes add to the activity log are looked for (tests shorten it). */
  tailMs?: number;
  /** Finding groups worth reading (null: not signed in). */
  discovery?: Discovery | null;
}

/** The only actions local tools (Claude's MCP server) may take: the ones its tools call. */
const TOOL_ALLOWED = new Set(['/api/probe', '/api/watch', '/api/pull', '/api/audit', '/api/toggle', '/api/refresh', '/api/flag', '/api/news/refresh', '/api/discover']);

/** Who asked: the owner's page, or Claude through the tools' token (and which app it runs in). */
export interface Asker {
  actor: 'console' | 'claude';
  /** " · via Claude Desktop" for Claude's requests; empty for the owner's. */
  via: string;
}
const OWNER: Asker = { actor: 'console', via: '' };

/** The app an MCP request came from, as the MCP server names it (x-agent-client). */
export function askerFor(role: 'page' | 'tool', client: unknown): Asker {
  if (role === 'page') return OWNER;
  const name = clientLabel(client);
  return { actor: 'claude', via: name ? ` · via ${name}` : '' };
}

/** At most this many of Claude's flags an hour become a notification; the rest are only recorded. */
const FLAG_NOTICES_PER_HOUR = 4;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const ASSETS: Record<string, { file: URL; type: string }> = {
  '/console.js': { file: new URL('./console.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  '/console.css': { file: new URL('./console.css', import.meta.url), type: 'text/css; charset=utf-8' },
  '/crawler.js': { file: new URL('./crawler.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
};
const PAGE = new URL('./page.html', import.meta.url);

type NoiseRow = { chatId: number; total: number; removed: Record<string, number> };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Every digest file under data/digests (one folder per group, and older files at the top). */
function digestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
}

export function probeKey(chatId: number): string {
  return `probe:${chatId}`;
}

export class ConsoleServer {
  private readonly deps: ConsoleDeps;
  /** Injected into the page only: every action. */
  private readonly pageToken = randomBytes(24).toString('base64url');
  /** Written to the handoff file only: the actions in TOOL_ALLOWED. */
  private readonly toolToken = randomBytes(24).toString('base64url');
  private readonly streams = new Set<ServerResponse>();
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Rows other processes (the MCP server) add to the activity log: streamed too, a moment later. */
  private tail: ReturnType<typeof setInterval> | null = null;
  private tailId = 0;
  private readonly streamed = new Set<number>();
  private flagTimes: number[] = [];
  /** The bound port (differs from deps.port when that is 0: any free port). */
  private port: number;

  constructor(deps: ConsoleDeps) {
    this.deps = deps;
    this.port = deps.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.route(req, res).catch((err) => this.json(res, 500, { error: (err as Error).message }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
    if (this.deps.handoffFile) {
      mkdirSync(dirname(this.deps.handoffFile), { recursive: true });
      writeFileSync(this.deps.handoffFile, JSON.stringify({ url: this.url, token: this.toolToken, pid: process.pid }), { mode: 0o600 });
    }
    this.unsubscribe = this.deps.activity.subscribe((row) => {
      this.streamed.add(row.id);
      this.broadcast(row);
    });
    this.heartbeat = setInterval(() => {
      for (const s of this.streams) s.write(': keep-alive\n\n');
    }, 25_000);
    this.tailId = this.deps.store.lastActivityId();
    this.tail = setInterval(() => this.followLog(), this.deps.tailMs ?? 1500);
    this.tail.unref?.();
  }

  private broadcast(row: ActivityRow): void {
    const line = `id: ${row.id}\nevent: activity\ndata: ${JSON.stringify(row)}\n\n`;
    for (const s of this.streams) s.write(line);
  }

  /** Streams the rows this process did not write itself (Claude's tool calls, its saved digests). */
  followLog(): void {
    try {
      const rows = this.deps.store.activity({ afterId: this.tailId, limit: 500 });
      for (const row of rows) if (!this.streamed.has(row.id)) this.broadcast(row);
      if (rows.length) this.tailId = rows[rows.length - 1].id;
      for (const id of this.streamed) if (id <= this.tailId) this.streamed.delete(id);
    } catch {
      // the database busy for a moment: the next tick catches up
    }
  }

  async stop(): Promise<void> {
    if (this.deps.handoffFile) rmSync(this.deps.handoffFile, { force: true });
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.tail) clearInterval(this.tail);
    for (const s of this.streams) s.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw new Error('request too large');
    }
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(421).end('wrong host');
      return;
    }
    const url = new URL(req.url ?? '/', this.url);
    if (req.method === 'GET') {
      const asset = ASSETS[url.pathname];
      if (asset) {
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(readFileSync(asset.file));
        return;
      }
      switch (url.pathname) {
        case '/':
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': CSP,
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
          });
          res.end(readFileSync(PAGE, 'utf8').replace('__CONSOLE_TOKEN__', this.pageToken));
          return;
        case '/api/state':
          return this.json(res, 200, this.state());
        case '/api/activity': {
          const kind = url.searchParams.get('kind');
          return this.json(
            res,
            200,
            this.deps.store.activity({
              afterId: Number(url.searchParams.get('after') ?? 0) || 0,
              limit: Number(url.searchParams.get('limit') ?? 300) || 300,
              kind: kind ? (kind as 'read') : undefined,
            }),
          );
        }
        case '/api/messages':
          return this.json(res, 200, this.messages(Number(url.searchParams.get('chat')), Number(url.searchParams.get('limit') ?? 100), url.searchParams.get('noise') === '1'));
        case '/api/joined':
          return this.json(res, 200, await this.joined());
        case '/api/storage':
          return this.json(res, 200, this.storage());
        case '/api/signal':
          return this.json(res, 200, this.signal(Number(url.searchParams.get('chat')), Number(url.searchParams.get('hours') ?? 24)));
        case '/api/news':
          return this.json(res, 200, this.deps.news && this.deps.config.news ? this.deps.news.view() : { enabled: false, sources: [], keywords: [], hits: [], alerts: [], items24h: 0 });
        case '/api/pulse':
          return this.json(res, 200, this.pulse());
        case '/api/live':
          return this.json(res, 200, this.live());
        case '/api/discover':
          return this.json(res, 200, this.deps.discovery?.view() ?? { available: false, running: null, latest: [], budget: null });
        case '/api/events':
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(': connected\n\n');
          this.streams.add(res);
          req.on('close', () => this.streams.delete(res));
          return;
      }
      res.writeHead(404).end('not found');
      return;
    }
    if (req.method === 'POST') {
      const token = String(req.headers['x-console-token'] ?? '');
      const role = same(token, this.pageToken) ? 'page' : same(token, this.toolToken) && TOOL_ALLOWED.has(url.pathname) ? 'tool' : null;
      if (!role || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await this.body(req);
      const invites = this.deps.invites ?? null;
      const id = Number(body.id);
      const asker = askerFor(role, req.headers['x-agent-client']);
      switch (url.pathname) {
        case '/api/probe':
          return this.json(res, 200, await this.probe(String(body.target ?? ''), role === 'tool' ? 'mcp' : 'owner', asker));
        case '/api/watch':
          return this.json(res, 200, await this.watch(String(body.target ?? ''), asker));
        case '/api/invite/opened':
          return this.json(res, 200, invites?.opened(id) ?? { error: 'Unknown invite.' });
        case '/api/invite/confirm':
          return this.json(res, 200, invites?.confirm(id, body.said === 'requested' ? 'requested' : 'joined') ?? { error: 'Unknown invite.' });
        case '/api/invite/recheck':
          return this.json(res, 200, invites?.recheck(id) ?? { error: 'Unknown invite.' });
        case '/api/invite/dismiss':
          return this.json(res, 200, invites?.dismiss(id) ?? { error: 'Unknown invite.' });
        case '/api/membership/check':
          return this.json(res, 200, invites ? await withTimeout(invites.checkMembership(Number(body.chatId)), 60_000, 'the check').catch((err) => ({ ok: false, message: (err as Error).message })) : { ok: false, message: 'The reader account is not signed in.' });
        case '/api/notify-test':
          return this.json(res, 200, this.notifyTest());
        case '/api/unwatch':
          return this.json(res, 200, this.unwatch(Number(body.chatId)));
        case '/api/pull':
          return this.json(res, 200, await this.pull(Number(body.chatId), asker));
        case '/api/digest':
          return this.json(res, 200, await this.digest(Number(body.chatId)));
        case '/api/audit':
          return this.json(res, 200, await this.audit(Number(body.chatId), Number(body.hours ?? 1), asker));
        case '/api/toggle':
          return this.json(res, 200, this.toggle(Number(body.chatId), body.on === true, asker));
        case '/api/flag':
          return this.json(res, 200, this.flag(body, asker));
        case '/api/discover':
          return this.json(res, 200, this.deps.discovery?.start(String(body.topic ?? ''), typeof body.query === 'string' ? body.query.slice(0, 64) : null, asker) ?? { ok: false, message: 'The reader account is not signed in.' });
        case '/api/discover/dismiss':
          return this.json(res, 200, this.deps.discovery?.dismiss(Number(body.chatId)) ?? { ok: false, message: 'The reader account is not signed in.' });
        case '/api/refresh':
          return this.json(res, 200, await this.refreshList(asker));
        case '/api/settings':
          return this.json(res, 200, this.settings(body));
        case '/api/clear':
          return this.json(res, 200, this.clear(body));
        case '/api/news/feed':
          return this.json(res, 200, this.deps.news ? await withTimeout(this.deps.news.addFeed(String(body.url ?? ''), String(body.name ?? '')), 30_000, 'reading the feed').catch((err) => ({ ok: false, message: (err as Error).message })) : { ok: false, message: 'The news radar is off.' });
        case '/api/news/toggle':
          return this.json(res, 200, this.deps.news?.setEnabled(String(body.id ?? ''), body.on === true) ?? { ok: false, message: 'The news radar is off.' });
        case '/api/news/remove':
          return this.json(res, 200, this.deps.news?.remove(String(body.id ?? '')) ?? { ok: false, message: 'The news radar is off.' });
        case '/api/news/refresh':
          return this.json(res, 200, await this.newsRefresh(asker));
      }
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(405).end('method not allowed');
  }

  // ── read ─────────────────────────────────────────────────────────────────

  private state() {
    const { store, config, now: clock } = this.deps;
    const now = clock();
    const day = now - 86_400;
    const stats = store.messageStats(day);
    const sources = store
      .listChats(false)
      .filter((c) => c.kind !== 'report')
      .map((c) => {
        const st = stats.get(c.chatId);
        const probeJson = store.getKv(probeKey(c.chatId));
        const p = probeJson ? (JSON.parse(probeJson) as ProbeResult) : null;
        return {
          chatId: c.chatId,
          title: c.title,
          ref: c.readerRef ?? (c.username ? `@${c.username}` : String(c.chatId)),
          kind: c.kind,
          enabled: c.enabled,
          access: p ? (p.member ? 'member' : p.verdict === 'read-from-outside' ? 'outside' : p.verdict) : c.readerOrigin === 'dialog' ? 'member' : null,
          members: p?.members ?? null,
          perDay: p?.history?.perDay ?? null,
          bots: p?.bots ?? [],
          door: p?.door ?? null,
          messages24h: st?.count ?? 0,
          people24h: st?.people ?? 0,
          newest: st?.newest ?? null,
          cursor: c.readerCursor,
          behind: this.deps.reader?.isBehind(c.chatId) ?? false,
          origin: c.readerOrigin,
          offReason: c.enabled ? null : store.getKv(`reader_off_reason:${c.chatId}`) || null,
          caughtUpAt: Number(store.getKv(`reader_caught_up:${c.chatId}`) ?? 0) || null,
          // How fast it is read: pushed by Telegram (the account is in it), or polled from outside.
          pushed: this.deps.reader?.isPushed(c.chatId) ?? false,
          peeked: this.deps.reader?.isPeeked(c.chatId) ?? false,
          member: this.deps.reader?.isMember(c.chatId) ?? c.readerOrigin === 'dialog',
          everyS: this.deps.reader?.intervalOf(c.chatId) ?? config.readerPollSeconds,
          lastPushAt: this.deps.reader?.lastPush(c.chatId) ?? null,
          error: c.readerError,
          reportTo: c.reportChatId,
          lastDigestAt: c.lastDigestAt,
          nextDigestAt: lastSlot(now, c.timezone, c.digestHour) + 86_400,
          timezone: c.timezone,
        };
      });
    const titles = new Map(store.listChats(false).map((c) => [c.chatId, c.title]));
    return {
      now,
      startedAt: this.deps.startedAt,
      account: this.deps.account
        ? { name: this.deps.account.name, id: this.deps.account.id, session: config.readerSession, connection: this.deps.account.state?.() ?? null, pushes: this.deps.account.pushes?.() ?? null }
        : null,
      readerConfigured: Boolean(config.telegramApiId),
      bot: this.deps.bot,
      claude: this.deps.claude,
      reportTo: config.reportTo,
      autoWatchNew: (store.getKv('auto_watch_new') || (config.autoWatchNew ? 'on' : 'off')) === 'on',
      privateGroups: this.deps.invites?.views() ?? null,
      notifications: Boolean(this.deps.notifier) && config.notify && process.platform === 'darwin',
      pollSeconds: config.readerPollSeconds,
      liveSeconds: config.readerLiveSeconds,
      peekSeconds: config.readerPeekSeconds,
      news: this.newsSummary(),
      retentionDays: config.retentionDays,
      sources,
      activity: store.activitySummary(day),
      costs: { day: store.usageTotals(day), all: store.usageTotals(0) },
      digests: store.recentDigests(20).map((d) => ({
        id: d.id,
        chatId: d.chatId,
        title: titles.get(d.chatId) ?? String(d.chatId),
        kind: d.kind,
        createdAt: d.createdAt,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        version: d.genomeVersion,
        delivered: d.postedIds.some((id) => id > 0),
      })),
      digestFolders: digestFolders(store.outbox(200), store.recentDigests(200), store.listChats(false)),
    };
  }

  /** What only this process knows, for the MCP server's status tool: the connection, and how each source is read. */
  private live() {
    const { reader, store, config, account } = this.deps;
    return {
      startedAt: this.deps.startedAt,
      account: account ? { connection: account.state?.() ?? null } : null,
      peekSeconds: config.readerPeekSeconds,
      sources: store
        .listChats(false)
        .filter((c) => c.kind === 'watched')
        .map((c) => ({
          chatId: c.chatId,
          pushed: reader?.isPushed(c.chatId) ?? false,
          peeked: reader?.isPeeked(c.chatId) ?? false,
          member: reader?.isMember(c.chatId) ?? c.readerOrigin === 'dialog',
          everyS: reader?.intervalOf(c.chatId) ?? config.readerPollSeconds,
          behind: reader?.isBehind(c.chatId) ?? false,
        })),
    };
  }

  /** For the status card: how many news sources answer, and what was flagged today. */
  private newsSummary() {
    const { store, config, now } = this.deps;
    if (!config.news || !this.deps.news) return null;
    const sources = store.newsSources().filter((x) => x.enabled);
    const day = now() - 86_400;
    const alerts = store.newsAlerts(day).filter((a) => a.kind !== 'echo');
    return {
      sources: sources.length,
      failing: sources.filter((x) => x.kind === 'rss' && x.lastError).map((x) => x.name),
      items24h: [...store.newsItemCounts(day).values()].reduce((a, b) => a + b, 0),
      alerts24h: alerts.length,
      lastAlert: alerts[0] ?? null,
    };
  }

  private newsAskedAt = 0;

  private async newsRefresh(asker: Asker = OWNER): Promise<{ ok: boolean; message: string }> {
    const news = this.deps.news;
    if (!news || !this.deps.config.news) return { ok: false, message: 'The news radar is off (PULSE_NEWS=off).' };
    // Claude may ask at most every two minutes: each ask reads every feed.
    if (asker.actor === 'claude' && this.deps.now() - this.newsAskedAt < 120) return { ok: true, message: `The feeds were read ${this.deps.now() - this.newsAskedAt}s ago; they are read every few minutes anyway.` };
    if (asker.actor === 'claude') this.newsAskedAt = this.deps.now();
    const before = this.deps.store.newsItemCounts(this.deps.now() - 86_400);
    await withTimeout(news.fetchDue(true), 120_000, 'reading the feeds').catch(() => undefined);
    await news.rebuild();
    const after = this.deps.store.newsItemCounts(this.deps.now() - 86_400);
    const added = [...after.values()].reduce((a, b) => a + b, 0) - [...before.values()].reduce((a, b) => a + b, 0);
    const failing = this.deps.store.newsSources().filter((x) => x.enabled && x.kind === 'rss' && x.lastError);
    this.deps.activity.event(asker.actor, 'news checked', 'all feeds', `${Math.max(0, added)} new items${failing.length ? `; not answering: ${failing.map((x) => x.name).join(', ')}` : ''}${asker.via}`);
    return { ok: true, message: `Feeds checked: ${Math.max(0, added)} new item${added === 1 ? '' : 's'}${failing.length ? `; not answering: ${failing.map((x) => x.name).join(', ')}` : ''}.` };
  }

  /**
   * For the live view: each group's messages per hour over the last day, what the denoiser removed
   * from each over the last day (as the digest reads it), and how long recent messages took to be
   * stored. The denoiser counts are worked out once, then again in the background at most once a
   * minute, one group at a time, so a request never waits on a whole day of every group.
   */
  private pulse() {
    const { store, now: clock } = this.deps;
    const now = clock();
    const HOUR = 3600;
    const first = Math.floor(now / HOUR) - 23; // 24 buckets; the last one is the current hour
    const buckets = store.messageBuckets(first * HOUR, HOUR);
    if (!this.noise.rows) this.noise = { at: now, rows: this.noiseRows(now, null), running: false };
    else if (now - this.noise.at >= 60 && !this.noise.running) void this.refreshNoise();
    return {
      now,
      from: first * HOUR,
      bucketS: HOUR,
      hours: [...buckets].map(([chatId, m]) => ({ chatId, counts: Array.from({ length: 24 }, (_, i) => m.get(first + i) ?? 0) })),
      noise: this.noise.rows,
      lags: store.captureLags(now - 6 * HOUR, 60),
    };
  }

  private noise: { at: number; rows: NoiseRow[] | null; running: boolean } = { at: 0, rows: null, running: false };

  /** What the denoiser removes from each watched group's last day. `pause` lets the event loop breathe between groups. */
  private noiseRows(now: number, pause: null): NoiseRow[];
  private noiseRows(now: number, pause: () => Promise<void>): Promise<NoiseRow[]>;
  private noiseRows(now: number, pause: (() => Promise<void>) | null): NoiseRow[] | Promise<NoiseRow[]> {
    const { store } = this.deps;
    const chats = store.listChats(false).filter((c) => c.kind === 'watched' && c.enabled);
    const one = (chatId: number): NoiseRow => {
      const d = denoise(store.messages(chatId, now - 86_400, now + 1));
      return { chatId, total: d.total, removed: d.removed };
    };
    if (!pause) return chats.map((c) => one(c.chatId)).filter((x) => x.total > 0);
    return (async () => {
      const rows: NoiseRow[] = [];
      for (const c of chats) {
        rows.push(one(c.chatId));
        await pause();
      }
      return rows.filter((x) => x.total > 0);
    })();
  }

  private async refreshNoise(): Promise<void> {
    this.noise.running = true;
    try {
      const now = this.deps.now();
      const rows = await this.noiseRows(now, () => new Promise<void>((resolve) => setImmediate(resolve)));
      this.noise = { at: now, rows, running: false };
    } catch {
      this.noise.running = false;
    }
  }

  /**
   * The last `limit` messages of a chat. With `withNoise`, each message of the last 6 hours also says
   * whether the denoiser drops it and why, or null when it is kept (older ones carry no verdict). The
   * rules are the digest's; the digest judges a whole day, so it also catches a repeat of something
   * said earlier than that.
   */
  private messages(chatId: number, limit: number, withNoise = false) {
    const { store, now } = this.deps;
    const users = store.users(chatId);
    const end = now() + 1;
    const want = Math.min(Math.max(limit, 1), 500);
    // The last day usually holds them; only a quiet chat needs the whole history.
    const day = store.messages(chatId, end - 86_400, end);
    const rows = (day.length >= want ? day : store.messages(chatId, 0, end)).slice(-want);
    const judgedFrom = end - 6 * 3600;
    const noise = withNoise ? denoise(day.filter((m) => m.date >= judgedFrom)).noise : null;
    return rows.map((m) => ({
      id: m.messageId,
      date: m.date,
      author: users.get(m.userId)?.displayName ?? String(m.userId),
      text: m.text,
      replyTo: m.replyTo,
      reactions: m.reactions,
      ...(noise && m.date >= judgedFrom ? { noise: noise.get(m.messageId) ?? null } : {}),
    }));
  }

  /** The denoised, on-topic lines of a window: what Claude reads. */
  private signal(chatId: number, hours: number) {
    const { store, now } = this.deps;
    const end = now() + 1;
    const msgs = store.messages(chatId, end - Math.min(Math.max(hours, 1), 168) * 3600, end);
    const users = store.users(chatId);
    const d = denoise(msgs);
    const name = (id: number) => users.get(id)?.displayName ?? String(id);
    return {
      header: formatSignal(d, name, () => '').header,
      lines: d.conversations
        .filter((c) => c.onTopic)
        .flatMap((c) => c.lines)
        .sort((a, b) => a.date - b.date)
        .slice(-300)
        .map((l) => ({ ids: l.ids, date: l.date, author: name(l.userId), text: l.text, replies: l.replies, echoes: l.echoes, score: l.score })),
    };
  }

  private joinedAt = 0;
  private joinedList: Awaited<ReturnType<Reader['joined']>> | null = null;

  /** The account's own groups and channels, and whether each is watched. Asked of Telegram at most every 30 s. */
  private async joined(): Promise<{ error?: string; chats: { chatId: number; title: string; ref: string; type: string; members: number | null; watched: boolean }[] }> {
    const { reader, store } = this.deps;
    if (!reader) return { error: 'The reader account is not signed in.', chats: [] };
    try {
      const fresh = this.joinedList && this.deps.now() - this.joinedAt < 30;
      const list = fresh ? this.joinedList! : await withTimeout(reader.joined(), 60_000, 'listing your chats');
      if (!fresh) {
        this.joinedList = list;
        this.joinedAt = this.deps.now();
      }
      return {
        chats: list.map((c) => {
          const row = store.getChat(c.chatId);
          return { chatId: c.chatId, title: c.title, ref: c.ref, type: c.type, members: c.members, watched: Boolean(row && row.kind === 'watched' && row.enabled) };
        }),
      };
    } catch (err) {
      return { error: (err as Error).message, chats: [] };
    }
  }

  /** What is stored, and how big the files are. */
  private storage() {
    const { store, config } = this.deps;
    const dataDir = dirname(config.dbPath);
    const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
    return {
      ...store.storageCounts(),
      digestFiles: digestFiles(join(dataDir, 'digests')).length,
      bytes: size(config.dbPath) + size(`${config.dbPath}-wal`) + size(join(dataDir, 'monitor.log')),
      retentionDays: config.retentionDays,
    };
  }

  // ── actions ──────────────────────────────────────────────────────────────

  private async probe(target: string, lane: 'owner' | 'mcp', asker: Asker = OWNER): Promise<unknown> {
    const { account, activity } = this.deps;
    if (!account) return { error: 'The reader account is not signed in.' };
    if (!target.trim()) return { error: 'Type a @username, a t.me link or an invite link.' };
    // An invite link: the private-group flow (a rationed look, then joining in the Telegram app).
    if (this.deps.invites && inviteHash(target)) {
      return withTimeout(this.deps.invites.preview(target.trim(), lane, asker.via), 150_000, 'the check').catch((err) => ({ error: (err as Error).message }));
    }
    const shown = parseRef(target)?.kind === 'invite' ? 'an invite link' : target; // never log a full invite hash
    activity.event(asker.actor, 'probe', shown, `read-only look requested${asker.via}`);
    let r: ProbeResult;
    try {
      r = await withTimeout(probe(account.raw, target.trim(), this.deps.now()), 120_000, 'the check');
    } catch (err) {
      return { error: (err as Error).message };
    }
    activity.event('probe', r.verdict, r.title ?? target, r.summary, r.verdict !== 'not-found');
    if (r.chatId) this.deps.store.setKv(probeKey(r.chatId), JSON.stringify(r));
    return r;
  }

  private async watch(target: string, asker: Asker = OWNER): Promise<{ ok: boolean; message: string; chatId?: number }> {
    const { reader, store, config, activity } = this.deps;
    if (!reader) return { ok: false, message: 'The reader account is not signed in.' };
    if (config.reportTo === null) return { ok: false, message: 'Set PULSE_OWNER_IDS (or PULSE_REPORT_TO) in .env so digests have somewhere to go.' };
    const hash = inviteHash(target);
    if (hash && this.deps.invites) {
      return withTimeout(this.deps.invites.watchMember(hash, { actor: asker.actor === 'claude' ? 'claude' : 'owner', via: asker.via }), 90_000, 'starting to read it').catch((err) => ({ ok: false, message: (err as Error).message }));
    }
    const ref = target.trim();
    let info;
    try {
      info = await withTimeout(reader.resolve(ref), 60_000, 'finding the group');
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    const known = store.getChat(info.chatId);
    if (known?.kind === 'watched') store.updateChat(info.chatId, { enabled: true, readerError: null });
    else store.watchChat(info, config.reportTo, null, { language: config.language, digestHour: config.digestHour, timezone: config.timezone, rsiMode: config.rsiMode });
    if (!store.getChat(info.chatId)?.readerOrigin) store.updateChat(info.chatId, { readerOrigin: 'manual' });
    store.setKv(`reader_off_reason:${info.chatId}`, '');
    activity.event(asker.actor, 'watch', info.title, `${info.ref}: reading from now on (first pull goes back 24 hours)${asker.via}`);
    if (!store.getKv(probeKey(info.chatId)) && this.deps.account) {
      const raw = this.deps.account.raw;
      void probe(raw, info.ref, this.deps.now()).then((r) => r.chatId && store.setKv(probeKey(r.chatId), JSON.stringify(r))).catch(() => undefined);
    }
    void reader
      .pullNow(info.chatId)
      .then((n) => activity.event('reader', 'first pull', info.title, `${n} messages from the last 24 hours`))
      .catch((err) => {
        store.updateChat(info.chatId, { readerError: (err as Error).message.slice(0, 300) });
        activity.event('reader', 'first pull', info.title, (err as Error).message, false);
      });
    return { ok: true, message: `Watching ${info.title}. The first pull (last 24 hours) is running; watch the activity feed.`, chatId: info.chatId };
  }

  private unwatch(chatId: number): { ok: boolean; message: string } {
    return this.toggle(chatId, false);
  }

  /**
   * The per-source switch. Off: not read any more (what was stored stays until retention). On: read
   * again, catching up from where it stopped but no further back than 24 hours. The owner's choice
   * sticks: following the chat list never switches back on what the owner switched off.
   */
  private toggle(chatId: number, on: boolean, asker: Asker = OWNER): { ok: boolean; message: string } {
    const { store, activity, reader } = this.deps;
    const chat = store.getChat(chatId);
    if (!chat || chat.kind !== 'watched') return { ok: false, message: 'Not a source.' };
    if (on === chat.enabled) return { ok: true, message: `${chat.title} is already ${on ? 'on' : 'off'}.` };
    if (on) {
      store.updateChat(chatId, { enabled: true, readerError: null });
      store.setKv(`reader_off_reason:${chatId}`, '');
      store.setKv(`reader_floor:${chatId}`, String(this.deps.now() - 86_400));
      activity.event(asker.actor, 'switched on', chat.title, `reading again: catching up from where it stopped, at most 24 hours back${asker.via}`);
      if (reader) void reader.pull(store.getChat(chatId)!).catch(() => undefined);
      return { ok: true, message: `${chat.title}: on. Catching up (at most the last 24 hours).` };
    }
    store.updateChat(chatId, { enabled: false });
    // Either way it stays off: following the chat list switches back on only what the account had left.
    store.setKv(`reader_off_reason:${chatId}`, asker.actor === 'claude' ? 'claude' : 'owner');
    activity.event(asker.actor, 'switched off', chat.title, `not read any more; stored messages stay until retention deletes them${asker.via}`);
    return { ok: true, message: `${chat.title}: off. It is not read any more.` };
  }

  /** Re-checks the account's chat list now (it also runs hourly, and soon after a join). */
  private async refreshList(asker: Asker = OWNER): Promise<{ ok: boolean; message: string }> {
    const { reader } = this.deps;
    if (!reader) return { ok: false, message: 'The reader account is not signed in.' };
    try {
      const r = await withTimeout(reader.reconcile(), 120_000, 'checking the chat list');
      const parts = [
        r.added.length ? `new: ${r.added.map((c) => c.title).join(', ')}` : 'no new chats',
        r.left.length ? `left: ${r.left.map((c) => c.title).join(', ')}` : '',
      ].filter(Boolean);
      // The owner sees the answer on the page; Claude's request leaves a line of its own.
      if (asker.actor === 'claude') this.deps.activity.event('claude', 'chat list checked', '', `${parts.join('; ')}${asker.via}`);
      return { ok: true, message: `Chat list checked: ${parts.join('; ')}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  /**
   * The owner's "clear storage" button: deletes, for good, what was collected (the chosen parts).
   * Only the console offers it (a person clicks it); Claude's tools cannot.
   */
  private clear(body: Record<string, unknown>): { ok: boolean; message: string } {
    const { store, config, activity } = this.deps;
    const what = { messages: body.messages === true, activity: body.activity === true, digests: body.digests === true };
    if (!what.messages && !what.activity && !what.digests) return { ok: false, message: 'Nothing chosen to clear.' };
    const before = this.storage().bytes;
    const dataDir = dirname(config.dbPath);
    let files = 0;
    if (what.digests) {
      const dir = join(dataDir, 'digests');
      for (const f of digestFiles(dir)) {
        rmSync(f, { force: true });
        files++;
      }
      // The per-group folders, once empty.
      if (existsSync(dir)) for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && readdirSync(join(dir, d.name)).length === 0) rmSync(join(dir, d.name), { recursive: true });
    }
    if (what.activity && existsSync(join(dataDir, 'monitor.log'))) truncateSync(join(dataDir, 'monitor.log'));
    const { deleted, compacted } = store.clearStored(what);
    const after = this.storage().bytes;
    const parts = [
      what.messages ? `${deleted.messages ?? 0} messages and ${deleted.people ?? 0} names` : '',
      what.activity ? `${deleted.activity ?? 0} activity rows` : '',
      what.digests ? `${deleted.digests ?? 0} digests, ${deleted.outbox ?? 0} outgoing messages and ${files} digest files` : '',
    ].filter(Boolean);
    const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
    const summary = `deleted ${parts.join(', ')}; storage ${mb(before)} → ${mb(after)}${compacted ? '' : ' (the file shrinks at the next clear: it was busy)'}`;
    // The one trace that remains: that a clear happened (not what was in it).
    activity.event('console', 'cleared storage', 'owner', summary);
    return { ok: true, message: `Cleared: ${summary}. Sources, switches and reading positions are kept, so nothing is downloaded again.` };
  }

  /**
   * Claude's way to reach the owner. Its note goes into the activity log, where the console shows
   * it; the notification says only that a note is waiting, in our own words, so nothing a group
   * wrote can reach the owner's screen through Claude. At most FLAG_NOTICES_PER_HOUR are shown an
   * hour; the rest are recorded all the same.
   */
  private flag(body: Record<string, unknown>, asker: Asker): { ok: boolean; message: string; notified?: boolean } {
    const { store, activity, notifier, config, now } = this.deps;
    const note = clean(String(body.note ?? ''), 500);
    if (!note) return { ok: false, message: 'Say what needs the owner, in a sentence or two.' };
    const named = body.chatId !== undefined && body.chatId !== null;
    const chat = named ? store.getChat(Number(body.chatId)) : null;
    if (named && !chat) return { ok: false, message: 'Unknown group.' };
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20) : [];
    activity.event(asker.actor, 'flagged', chat?.title ?? '', `${note}${ids.length ? ` · ${ids.map((n) => `#${n}`).join(' ')}` : ''}${asker.via}`);
    const t = now();
    this.flagTimes = this.flagTimes.filter((x) => x > t - 3600);
    const where = `Recorded in the console (Activity)${chat ? ` for ${chat.title}` : ''}.`;
    if (!notifier || !config.notify || process.platform !== 'darwin') return { ok: true, notified: false, message: `${where} Notifications are off, so the owner sees it there.` };
    if (this.flagTimes.length >= FLAG_NOTICES_PER_HOUR) return { ok: true, notified: false, message: `${where} No notification: ${FLAG_NOTICES_PER_HOUR} were shown in the last hour already.` };
    this.flagTimes.push(t);
    // No group title either: Claude chose the group, and a title is text its admins wrote.
    notifier.notify({ kind: 'flag', group: null, body: 'Claude left you a note in the console (Activity).' });
    return { ok: true, notified: true, message: `Recorded in the console (Activity)${chat ? ` for ${chat.title}` : ''}, and a notification tells the owner a note is waiting.` };
  }

  private notifyTest(): { ok: boolean; message: string } {
    const { notifier, config } = this.deps;
    if (!notifier || !config.notify || process.platform !== 'darwin') return { ok: false, message: 'Notifications are off (they need macOS; PULSE_NOTIFY=on).' };
    notifier.notify({ kind: 'test', group: null, body: 'Notifications work. Nothing was sent to Telegram.' });
    this.deps.activity.event('console', 'test', 'notification', 'test notification requested');
    return { ok: true, message: 'Sent. If nothing appears, allow notifications for "Script Editor" in System Settings → Notifications, and check Focus.' };
  }

  private settings(body: Record<string, unknown>): { ok: boolean; message: string } {
    if (typeof body.autoWatchNew === 'boolean') {
      this.deps.store.setKv('auto_watch_new', body.autoWatchNew ? 'on' : 'off');
      this.deps.activity.event('console', 'setting', 'auto-watch', body.autoWatchNew ? 'groups and channels the account joins are read automatically' : 'groups and channels the account joins are listed switched off');
      return { ok: true, message: body.autoWatchNew ? 'New groups you join will be read automatically.' : 'New groups you join will be listed, switched off.' };
    }
    return { ok: false, message: 'Nothing to change.' };
  }

  private async pull(chatId: number, asker: Asker = OWNER): Promise<{ ok: boolean; message: string }> {
    const { reader, store, activity } = this.deps;
    const chat = store.getChat(chatId);
    if (!reader || !chat || chat.kind !== 'watched') return { ok: false, message: 'Not a watched source, or no reader account.' };
    try {
      const before = store.countMessages(chatId, 0, this.deps.now() + 86_400);
      const current = await withTimeout(reader.catchUp(chat, 5 * 60_000), 6 * 60_000, 'catching up');
      const n = store.countMessages(chatId, 0, this.deps.now() + 86_400) - before;
      activity.event(asker.actor, 'catch up', chat.title, `${n} new messages${current ? ', up to date' : ', still catching up'}${asker.via}`);
      return { ok: true, message: `${n} new messages; ${current ? 'up to date' : 'still catching up (a lot was posted while offline)'}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async audit(chatId: number, hours: number, asker: Asker = OWNER): Promise<{ ok: boolean; message: string; result?: unknown }> {
    const { reader, store, activity, now } = this.deps;
    const chat = store.getChat(chatId);
    if (!reader || !chat || chat.kind !== 'watched') return { ok: false, message: 'Not a watched source, or no reader account.' };
    const h = Math.min(Math.max(hours || 1, 1), 24);
    try {
      const r = await withTimeout(reader.audit(chat, now() - h * 3600), 120_000, 'the audit');
      const message =
        `Last ${h}h, checked against Telegram: ${r.checked} messages; ${r.stored} stored, ${r.bots} from bots, ${r.service} service messages (joins, pins), ${r.empty} empty — ` +
        (r.missing.length ? `${r.missing.length} MISSING (#${r.missing.slice(0, 10).join(', #')}).` : 'nothing missing.') +
        (r.newerThanCursor ? ` ${r.newerThanCursor} newer ones arrive with the next pull.` : '');
      activity.event(asker.actor, 'audit', chat.title, `${message}${asker.via}`, r.missing.length === 0);
      return { ok: r.missing.length === 0, message, result: r };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async digest(chatId: number): Promise<{ ok: boolean; message: string }> {
    const { claude, digestNow, store } = this.deps;
    const chat = store.getChat(chatId);
    if (!chat) return { ok: false, message: 'Unknown source.' };
    if (!claude.ready || !digestNow) return { ok: false, message: 'Claude is not configured: set ANTHROPIC_API_KEY in .env and restart.' };
    const outcome = await digestNow(chatId);
    return { ok: outcome === 'posted', message: `Digest: ${outcome}.` };
  }
}
