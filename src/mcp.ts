// The monitor inside Claude (the desktop app, Claude Code, scheduled tasks) as an MCP server over
// stdio. Claude reads what the reader account captured and writes the digest itself: no bot and
// no API key needed. Read tools use the local database. Tools that need Telegram go through the
// running service's console, never a second connection: the same session used twice at once can
// get it revoked (AUTH_KEY_DUPLICATED).
//
//   node --env-file-if-exists=/path/to/.env /path/to/src/mcp.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Activity } from './activity.ts';
import { loadConfig } from './config.ts';
import { denoise, formatSignal } from './denoise.ts';
import { formatInviteStatus, InviteBudget } from './invite-rules.ts';
import { SEED_PLAYBOOK } from './prompts.ts';
import { escapeHtml } from './render.ts';
import { Store, type ChatRow } from './store.ts';
import { buildTranscript, localDate, localTime } from './transcript.ts';

// Claude starts this from anywhere; the project's relative paths (./data/…) are from its root.
process.chdir(new URL('..', import.meta.url).pathname);
const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'unused-here' });
const store = new Store(config.dbPath);
const activity = new Activity(store);
const now = () => Math.floor(Date.now() / 1000);
const CONSOLE_FILE = join('data', 'console.json');
// One tool result must fit Claude's MCP output limit (25k tokens by default); Chinese runs ~1 token a character.
const PAGE_CHARS = 18_000;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

/** The running service's console, if it is up (it writes data/console.json while running). */
function service(): { url: string; token: string } | null {
  if (!existsSync(CONSOLE_FILE)) return null;
  try {
    const c = JSON.parse(readFileSync(CONSOLE_FILE, 'utf8')) as { url: string; token: string; pid: number };
    try {
      process.kill(c.pid, 0); // signal 0: only asks whether the process exists
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null; // ESRCH: gone. EPERM: alive, just not ours to signal.
    }
    return c;
  } catch {
    return null;
  }
}

async function callService(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const s = service();
  if (!s) throw new Error('The monitor service is not running. Start it with `npm start` in /Users/zhelinqi/tg-pulse (it holds the Telegram session).');
  const res = await fetch(`${s.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': s.token }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`console answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

function sources(): ChatRow[] {
  return store.listChats(false).filter((c) => c.kind === 'watched' || c.kind === 'group');
}

/** A source by title, @username, t.me link, -100… id, or #n from list_sources; or the only one. */
function pick(ref: string | undefined, includeOff = false): ChatRow {
  const all = sources().filter((c) => includeOff || c.enabled);
  if (!ref || !ref.trim()) {
    if (all.length === 1) return all[0];
    throw new Error(all.length ? `Several sources; name one: ${all.map((c, i) => `#${i + 1} ${c.title}`).join(' · ')}` : 'Nothing is watched yet.');
  }
  const r = ref.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').toLowerCase();
  const n = /^#(\d+)$/.exec(r);
  const hit = n
    ? all[Number(n[1]) - 1]
    : all.find((c) => String(c.chatId) === r || c.username?.toLowerCase() === r || c.readerRef?.replace(/^@/, '').toLowerCase() === r || c.title.toLowerCase() === r) ??
      all.find((c) => c.title.toLowerCase().includes(r));
  if (!hit) throw new Error(`No watched source matches "${ref}". Sources: ${all.map((c) => `${c.title} (${c.readerRef ?? c.chatId})`).join(' · ') || 'none'}`);
  return hit;
}

const when = (t: number | null, tz: string) => (t ? `${localDate(t, tz)} ${localTime(t, tz)}` : '—');

function freshness(c: ChatRow): string {
  const caught = Number(store.getKv(`reader_caught_up:${c.chatId}`) ?? 0);
  const running = service() !== null;
  const lag = caught ? Math.round((now() - caught) / 60) : null;
  if (!running) return `service NOT running: nothing new since ${caught ? when(caught, c.timezone) : 'start'}; messages posted since then come in when it starts again`;
  return lag === null ? 'service running; first catch-up not finished' : `service running; caught up ${lag <= 1 ? 'just now' : `${lag} min ago`}`;
}

const server = new McpServer({ name: 'telegram-monitor', version: '0.1.0' });

server.registerTool(
  'list_sources',
  {
    title: 'List watched Telegram groups',
    description:
      'The Telegram groups and channels the monitor reads, with how many messages it captured in the last 24 hours, how fresh the capture is, and whether the monitor service is running. Start here.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const day = now() - 86_400;
    const stats = store.messageStats(day);
    const lines = sources().map((c, i) => {
      const st = stats.get(c.chatId);
      return [
        `#${i + 1} ${c.title} (${c.readerRef ?? c.chatId}) [${c.enabled ? 'ON' : 'OFF'}]${c.readerOrigin === 'dialog' ? ' · from the account\'s chats' : ''}`,
        `   last 24h: ${st?.count ?? 0} messages from ${st?.people ?? 0} people; newest ${when(st?.newest ?? null, c.timezone)} (${c.timezone})`,
        `   ${freshness(c)}`,
      ].join('\n');
    });
    return text(lines.length ? lines.join('\n') : 'Nothing is watched yet. Use watch_source with a @username or t.me link.');
  },
);

/** Splits text blocks into pages of at most PAGE_CHARS (a block is never split unless it alone is too big). */
function paginate(blocks: string[]): string[] {
  const pages: string[] = [''];
  for (const b of blocks) {
    const cur = pages[pages.length - 1];
    if (cur && cur.length + b.length + 1 > PAGE_CHARS) pages.push('');
    pages[pages.length - 1] += `${pages[pages.length - 1] ? '\n' : ''}${b.length > PAGE_CHARS ? `${b.slice(0, PAGE_CHARS)}…` : b}`;
  }
  return pages;
}

server.registerTool(
  'read_messages',
  {
    title: 'Read captured messages',
    description:
      'Messages of one source for a time window, oldest first. Default view "signal": noise removed (stickers, one-word chatter, repeats, scams), ' +
      "each person's consecutive fragments joined, replies grouped into conversations, and off-topic conversations (nothing about crypto, trading, exchanges or money) folded into one paragraph. " +
      'View "off-topic" shows the folded ones; view "all" shows every message unfiltered. Lines read [#id time name ↩replied-to ♥reactions ×repeats] text; "#id+2" means two more fragments were joined. ' +
      'Long windows come in pages: read every page before summarizing. Cite messages by #id.',
    inputSchema: {
      source: z.string().optional().describe('Title, @username, t.me link, -100… id, or #n from list_sources. Optional when only one source is watched.'),
      hours: z.number().min(1).max(24 * 7).default(24).describe('How far back from now (default 24).'),
      view: z.enum(['signal', 'off-topic', 'all']).default('signal'),
      page: z.number().int().min(1).default(1),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ source, hours, view, page }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    const end = now() + 1;
    const start = end - hours * 3600;
    const msgs = store.messages(c.chatId, start, end);
    const users = store.users(c.chatId);
    const name = (id: number) => users.get(id)?.displayName ?? String(id);
    const time = (t: number) => localTime(t, c.timezone);
    let intro: string;
    let blocks: string[];
    if (view === 'all') {
      intro = `${msgs.length} messages, unfiltered.`;
      blocks = msgs.map((m) => {
        const tags = [`#${m.messageId}`, time(m.date), name(m.userId)];
        if (m.replyTo !== null) tags.push(`↩${m.replyTo}`);
        if (m.reactions > 0) tags.push(`♥${m.reactions}`);
        return `[${tags.join(' ')}] ${m.text.replace(/\s+/g, ' ').slice(0, config.maxMessageChars)}`;
      });
    } else {
      const sig = formatSignal(denoise(msgs), name, time, view);
      intro = sig.header;
      blocks = view === 'signal' && sig.folded ? [...sig.blocks, '', sig.folded] : sig.blocks;
    }
    const pages = paginate(blocks);
    const p = Math.min(page, pages.length);
    const header = `${c.title} · ${when(start, c.timezone)} → ${when(end, c.timezone)} (${c.timezone}) · view ${view} · page ${p} of ${pages.length}\n${freshness(c)}\n${intro}\n`;
    return text(`${header}\n${pages[p - 1] || '(nothing in this window)'}${p < pages.length ? `\n\n… continue with page ${p + 1}` : ''}`);
  },
);

server.registerTool(
  'overview',
  {
    title: 'Overview of a window',
    description:
      'Numbers to plan a digest with: volume by hour, the most active people, the most replied-to and most reacted messages, and the busiest conversations (threads and bursts) with their message ids.',
    inputSchema: {
      source: z.string().optional(),
      hours: z.number().min(1).max(24 * 7).default(24),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ source, hours }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    const end = now() + 1;
    const window = { start: end - hours * 3600, end };
    const msgs = store.messages(c.chatId, window.start, window.end);
    if (msgs.length === 0) return text(`${c.title}: no messages in the last ${hours}h. ${freshness(c)}`);
    const users = store.users(c.chatId);
    const name = (id: number) => users.get(id)?.displayName ?? String(id);
    const t = buildTranscript(msgs, users, window, { title: c.title, timezone: c.timezone, maxMessageChars: 160 });
    const byHour = new Map<string, number>();
    const byPerson = new Map<number, number>();
    const replies = new Map<number, number>();
    for (const m of msgs) {
      const h = `${localTime(m.date, c.timezone).slice(0, 2)}:00`;
      byHour.set(h, (byHour.get(h) ?? 0) + 1);
      byPerson.set(m.userId, (byPerson.get(m.userId) ?? 0) + 1);
      if (m.replyTo !== null) replies.set(m.replyTo, (replies.get(m.replyTo) ?? 0) + 1);
    }
    const byId = new Map(msgs.map((m) => [m.messageId, m]));
    const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 120);
    const out = [
      `${c.title} · last ${hours}h · ${msgs.length} messages · ${t.people} people · ${freshness(c)}`,
      '',
      `Noise: ${formatSignal(denoise(msgs), name, (x) => localTime(x, c.timezone)).header}`,
      '',
      `By hour (${c.timezone}): ${[...byHour.entries()].sort().map(([h, n]) => `${h} ${n}`).join(' · ')}`,
      '',
      'Most active:',
      ...[...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => `  ${name(id)}: ${n}`),
      '',
      'Most replied-to:',
      ...[...replies.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, n]) => {
        const m = byId.get(id);
        return `  #${id} (${n} replies)${m ? ` ${name(m.userId)}: ${short(m.text)}` : ' (before the window)'}`;
      }),
      '',
      'Most reacted:',
      ...msgs.filter((m) => m.reactions > 0).sort((a, b) => b.reactions - a.reactions).slice(0, 10).map((m) => `  #${m.messageId} ♥${m.reactions} ${name(m.userId)}: ${short(m.text)}`),
      '',
      'Busiest conversations (ids to read in full):',
      ...t.hot.slice(0, 15).map((u) => `  ${u.kind} · ${u.ids.length} messages · ${u.people} people · #${u.ids[0]}…#${u.ids[u.ids.length - 1]} · ${short(u.preview)}`),
    ];
    return text(out.join('\n'));
  },
);

server.registerTool(
  'search_messages',
  {
    title: 'Search captured messages',
    description: 'Messages of one source containing a word or phrase (case-insensitive), newest first.',
    inputSchema: {
      source: z.string().optional(),
      query: z.string().min(1),
      hours: z.number().min(1).max(24 * 7).default(72),
      limit: z.number().int().min(1).max(200).default(60),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ source, query, hours, limit }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    const end = now() + 1;
    const q = query.toLowerCase();
    const users = store.users(c.chatId);
    const hits = store
      .messages(c.chatId, end - hours * 3600, end)
      .filter((m) => m.text.toLowerCase().includes(q))
      .reverse()
      .slice(0, limit);
    return text(
      hits.length
        ? hits.map((m) => `[#${m.messageId} ${when(m.date, c.timezone)} ${users.get(m.userId)?.displayName ?? m.userId}] ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
        : `No message in ${c.title} over the last ${hours}h contains "${query}".`,
    );
  },
);

server.registerTool(
  'get_playbook',
  {
    title: 'Digest playbook',
    description: 'How a digest of this source should be written: the sections and the rules for each. Read it before writing a digest.',
    inputSchema: { source: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ source }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    const g = store.champion(c.chatId, SEED_PLAYBOOK);
    return text(
      [
        `Playbook v${g.version} for ${c.title}:`,
        g.playbook,
        '',
        'Write the digest in the language the group mostly writes in. Sections: Topics, Pain points, New ideas, Opportunities, Open questions.',
        'Every item cites the messages it rests on as #id, and says only what those messages support. Merge repeats; skip greetings, spam and bot noise.',
      ].join('\n'),
    );
  },
);

/** A folder name for a group: its title, safe for any file system. */
function folderName(c: ChatRow): string {
  const safe = c.title.normalize('NFC').replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60);
  return safe || String(c.chatId);
}

server.registerTool(
  'save_digest',
  {
    title: 'Save a digest',
    description:
      "Saves a digest you wrote for one source: it appears in the monitor console (http://127.0.0.1:4830), in that group's folder under Digests, and as a Markdown file in data/digests/<group>/. Nothing is posted to Telegram.",
    inputSchema: {
      source: z.string().optional(),
      markdown: z.string().min(20).describe('The digest, in Markdown, citing messages as #id.'),
      hours: z.number().min(1).max(24 * 7).default(24).describe('The window it covers, in hours before now.'),
    },
  },
  async ({ source, markdown, hours }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    const end = now();
    const head = `${c.title} · ${when(end - hours * 3600, c.timezone)} → ${when(end, c.timezone)} (${c.timezone}) · written by Claude`;
    store.addOutbox(c.reportChatId ?? c.chatId, `<b>${escapeHtml(head)}</b>\n\n${escapeHtml(markdown)}`, false, c.chatId);
    const dir = join('data', 'digests', folderName(c));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${localDate(end, c.timezone)} ${localTime(end, c.timezone).replace(':', '')}.md`);
    writeFileSync(file, `# ${head}\n\n${markdown}\n`);
    activity.event('claude', 'digest saved', c.title, `${markdown.length} chars → ${file}`);
    return text(`Saved. It shows in the console (Digests & outgoing messages → ${c.title}) and in ${join(process.cwd(), file)}.`);
  },
);

server.registerTool(
  'account_activity',
  {
    title: 'What the reader account did',
    description: 'The latest requests the reader account sent to Telegram (reads, any writes) and the service events, newest last.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(60),
      kind: z.enum(['read', 'write', 'event', 'error', 'llm']).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ limit, kind }) => {
    const rows = store.activity({ limit, kind });
    const summary = store.activitySummary(now() - 86_400);
    const head = `Last 24h: ${summary.counts.read ?? 0} reads, ${summary.counts.write ?? 0} writes, ${summary.errors} errors.${summary.lastWrite ? ` Last write: ${summary.lastWrite.method} ${summary.lastWrite.target} at ${new Date(summary.lastWrite.at * 1000).toISOString()}.` : ' No writes.'}`;
    return text([head, '', ...rows.map((r) => `${new Date(r.at * 1000).toISOString()} ${r.ok ? r.kind.toUpperCase() : 'ERROR'} ${r.actor} ${r.method} ${r.target} ${r.detail}`.trim())].join('\n'));
  },
);

server.registerTool(
  'check_group',
  {
    title: 'Check a Telegram group (read-only)',
    description:
      'Looks at a group or channel without joining: whether the account can read it from outside, members, activity per day, join approval, hidden history, and the bots that guard it. ' +
      'For a private invite link (t.me/+…) it returns a preview with warnings and links to open it in the Telegram app: the owner joins there and then presses «I\'ve joined» in the console. ' +
      'You cannot join, confirm a join or answer a check. Invite checks are rationed (5 a day from here). Needs the monitor service running.',
    inputSchema: { target: z.string().describe('@username, t.me link, or invite link') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ target }) => {
    try {
      return text(JSON.stringify(await callService('/api/probe', { target }), null, 2));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'invite_status',
  {
    title: 'Private groups: invite links and standing',
    description:
      'The invite links the owner is following (previewed, request pending, joined, removed) and the account\'s standing in groups it joined through them (member, a check waiting, muted, removed). ' +
      'Read-only, from the local database: no Telegram request. It never shows a check\'s text or buttons: checks are answered by the owner in the Telegram app.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const titles = new Map(store.listChats(false).map((c) => [c.chatId, c.title]));
    const memberships = store.memberships().map((m) => ({ ...m, title: titles.get(m.chatId) ?? String(m.chatId) }));
    return text(formatInviteStatus(store.invites(), memberships, new InviteBudget(store, now).view(), now(), config.timezone));
  },
);

server.registerTool(
  'watch_source',
  {
    title: 'Start reading a group',
    description:
      'Starts reading a group or channel the account can read (from outside, or as a member), beginning 24 hours back. It never joins anything. Needs the monitor service running.',
    inputSchema: { target: z.string() },
    annotations: { openWorldHint: true },
  },
  async ({ target }) => {
    try {
      const r = await callService('/api/watch', { target });
      return r.ok ? text(String(r.message)) : fail(String(r.message));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'catch_up_now',
  {
    title: 'Catch up now',
    description: 'Fetches everything posted since the last capture (including while the service was off) before you read. Needs the monitor service running.',
    inputSchema: { source: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ source }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    try {
      const r = await callService('/api/pull', { chatId: c.chatId });
      return r.ok ? text(`${c.title}: ${String(r.message)}`) : fail(String(r.message));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'set_monitoring',
  {
    title: 'Switch a group on or off',
    description:
      'Turns reading of one group or channel on or off. Off: it is not read any more (stored messages stay until retention). On: it is read again, catching up from where it stopped but at most 24 hours back. Groups the account joins in Telegram show up on their own; this switch is how to leave one out. Needs the monitor service running.',
    inputSchema: { source: z.string().describe('Title, @username, -100… id, or #n from list_sources'), on: z.boolean() },
  },
  async ({ source, on }) => {
    let c: ChatRow;
    try {
      c = pick(source, true);
    } catch (err) {
      return fail((err as Error).message);
    }
    try {
      const r = await callService('/api/toggle', { chatId: c.chatId, on });
      return r.ok ? text(String(r.message)) : fail(String(r.message));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'refresh_sources',
  {
    title: 'Re-check the account\'s chat list',
    description:
      'Checks now which groups and channels the account is in: new ones become sources (read automatically when auto-read is on), ones it left stop being read. It also happens every hour and soon after a join. Needs the monitor service running.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const r = await callService('/api/refresh', {});
      return r.ok ? text(String(r.message)) : fail(String(r.message));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

server.registerTool(
  'audit_capture',
  {
    title: 'Audit the capture',
    description:
      'Compares the last hours of one source with Telegram itself: every message Telegram has is either stored, or skipped for a stated reason (bot, service message, empty); anything else is reported as missing. Needs the monitor service running.',
    inputSchema: { source: z.string().optional(), hours: z.number().min(1).max(24).default(1) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ source, hours }) => {
    let c: ChatRow;
    try {
      c = pick(source);
    } catch (err) {
      return fail((err as Error).message);
    }
    try {
      const r = await callService('/api/audit', { chatId: c.chatId, hours });
      return r.ok ? text(`${c.title}: ${String(r.message)}`) : fail(`${c.title}: ${String(r.message)}`);
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
