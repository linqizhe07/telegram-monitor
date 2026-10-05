// The console: a local web page that shows what the service is doing, live. It binds to
// 127.0.0.1 only, answers only requests addressed to that host (no DNS rebinding), and its few
// actions need a per-run token that only the page itself carries (no cross-site requests).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TelegramClient as GramClient } from 'telegram';
import type { Activity } from '../activity.ts';
import type { Config } from '../config.ts';
import { denoise, formatSignal } from '../denoise.ts';
import { probe, type ProbeResult } from '../probe.ts';
import { withTimeout, type Reader } from '../reader.ts';
import type { Store } from '../store.ts';
import { lastSlot } from '../transcript.ts';

export interface ConsoleDeps {
  store: Store;
  activity: Activity;
  config: Config;
  port: number;
  now: () => number;
  log: (line: string) => void;
  startedAt: number;
  account: { name: string; id: string; raw: GramClient; state?: () => { state: 'online' | 'offline'; since: number } } | null;
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
}

const ASSETS: Record<string, { file: URL; type: string }> = {
  '/console.js': { file: new URL('./console.js', import.meta.url), type: 'text/javascript; charset=utf-8' },
  '/console.css': { file: new URL('./console.css', import.meta.url), type: 'text/css; charset=utf-8' },
};
const PAGE = new URL('./page.html', import.meta.url);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function probeKey(chatId: number): string {
  return `probe:${chatId}`;
}

export class ConsoleServer {
  private readonly deps: ConsoleDeps;
  private readonly token = randomBytes(24).toString('base64url');
  private readonly streams = new Set<ServerResponse>();
  private server: Server | null = null;
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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
      writeFileSync(this.deps.handoffFile, JSON.stringify({ url: this.url, token: this.token, pid: process.pid }), { mode: 0o600 });
    }
    this.unsubscribe = this.deps.activity.subscribe((row) => {
      const line = `id: ${row.id}\nevent: activity\ndata: ${JSON.stringify(row)}\n\n`;
      for (const s of this.streams) s.write(line);
    });
    this.heartbeat = setInterval(() => {
      for (const s of this.streams) s.write(': keep-alive\n\n');
    }, 25_000);
  }

  async stop(): Promise<void> {
    if (this.deps.handoffFile) rmSync(this.deps.handoffFile, { force: true });
    this.unsubscribe?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
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
          res.end(readFileSync(PAGE, 'utf8').replace('__CONSOLE_TOKEN__', this.token));
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
          return this.json(res, 200, this.messages(Number(url.searchParams.get('chat')), Number(url.searchParams.get('limit') ?? 100)));
        case '/api/joined':
          return this.json(res, 200, await this.joined());
        case '/api/signal':
          return this.json(res, 200, this.signal(Number(url.searchParams.get('chat')), Number(url.searchParams.get('hours') ?? 24)));
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
      if (req.headers['x-console-token'] !== this.token || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await this.body(req);
      switch (url.pathname) {
        case '/api/probe':
          return this.json(res, 200, await this.probe(String(body.target ?? '')));
        case '/api/watch':
          return this.json(res, 200, await this.watch(String(body.target ?? '')));
        case '/api/unwatch':
          return this.json(res, 200, this.unwatch(Number(body.chatId)));
        case '/api/pull':
          return this.json(res, 200, await this.pull(Number(body.chatId)));
        case '/api/digest':
          return this.json(res, 200, await this.digest(Number(body.chatId)));
        case '/api/audit':
          return this.json(res, 200, await this.audit(Number(body.chatId), Number(body.hours ?? 1)));
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
          access: p ? (p.member ? 'member' : p.verdict === 'read-from-outside' ? 'outside' : p.verdict) : null,
          members: p?.members ?? null,
          perDay: p?.history?.perDay ?? null,
          bots: p?.bots ?? [],
          door: p?.door ?? null,
          messages24h: st?.count ?? 0,
          people24h: st?.people ?? 0,
          newest: st?.newest ?? null,
          cursor: c.readerCursor,
          behind: this.deps.reader?.isBehind(c.chatId) ?? false,
          caughtUpAt: Number(store.getKv(`reader_caught_up:${c.chatId}`) ?? 0) || null,
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
        ? { name: this.deps.account.name, id: this.deps.account.id, session: config.readerSession, connection: this.deps.account.state?.() ?? null }
        : null,
      readerConfigured: Boolean(config.telegramApiId),
      bot: this.deps.bot,
      claude: this.deps.claude,
      reportTo: config.reportTo,
      pollSeconds: config.readerPollSeconds,
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
      outbox: store.outbox(20),
    };
  }

  private messages(chatId: number, limit: number) {
    const { store, now } = this.deps;
    const users = store.users(chatId);
    const rows = store.messages(chatId, 0, now() + 1).slice(-Math.min(Math.max(limit, 1), 500));
    return rows.map((m) => ({
      id: m.messageId,
      date: m.date,
      author: users.get(m.userId)?.displayName ?? String(m.userId),
      text: m.text,
      replyTo: m.replyTo,
      reactions: m.reactions,
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

  /** The account's own groups and channels, and whether each is watched. */
  private async joined(): Promise<{ error?: string; chats: { chatId: number; title: string; ref: string; type: string; members: number | null; watched: boolean }[] }> {
    const { reader, store } = this.deps;
    if (!reader) return { error: 'The reader account is not signed in.', chats: [] };
    try {
      const list = await withTimeout(reader.joined(), 60_000, 'listing your chats');
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

  // ── actions ──────────────────────────────────────────────────────────────

  private async probe(target: string): Promise<ProbeResult | { error: string }> {
    const { account, activity } = this.deps;
    if (!account) return { error: 'The reader account is not signed in.' };
    if (!target.trim()) return { error: 'Type a @username, a t.me link or an invite link.' };
    activity.event('console', 'probe', target, 'read-only look requested from the console');
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

  private async watch(target: string): Promise<{ ok: boolean; message: string; chatId?: number }> {
    const { reader, store, config, activity } = this.deps;
    if (!reader) return { ok: false, message: 'The reader account is not signed in.' };
    if (config.reportTo === null) return { ok: false, message: 'Set PULSE_OWNER_IDS (or PULSE_REPORT_TO) in .env so digests have somewhere to go.' };
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
    activity.event('console', 'watch', info.title, `${info.ref}: reading from now on (first pull goes back 24 hours)`);
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
    const chat = this.deps.store.getChat(chatId);
    if (!chat || chat.kind !== 'watched') return { ok: false, message: 'Not a watched source.' };
    this.deps.store.updateChat(chatId, { enabled: false });
    this.deps.activity.event('console', 'unwatch', chat.title, 'no longer read; stored messages kept until retention deletes them');
    return { ok: true, message: `Stopped watching ${chat.title}.` };
  }

  private async pull(chatId: number): Promise<{ ok: boolean; message: string }> {
    const { reader, store, activity } = this.deps;
    const chat = store.getChat(chatId);
    if (!reader || !chat || chat.kind !== 'watched') return { ok: false, message: 'Not a watched source, or no reader account.' };
    try {
      const before = store.countMessages(chatId, 0, this.deps.now() + 86_400);
      const current = await withTimeout(reader.catchUp(chat, 5 * 60_000), 6 * 60_000, 'catching up');
      const n = store.countMessages(chatId, 0, this.deps.now() + 86_400) - before;
      activity.event('console', 'catch up', chat.title, `${n} new messages${current ? ', up to date' : ', still catching up'}`);
      return { ok: true, message: `${n} new messages; ${current ? 'up to date' : 'still catching up (a lot was posted while offline)'}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async audit(chatId: number, hours: number): Promise<{ ok: boolean; message: string; result?: unknown }> {
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
      activity.event('console', 'audit', chat.title, message, r.missing.length === 0);
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
