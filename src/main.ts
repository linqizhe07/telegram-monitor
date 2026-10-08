import { dirname, join } from 'node:path';
import { Activity } from './activity.ts';
import { PulseBot } from './bot.ts';
import { loadConfig } from './config.ts';
import { ConsoleServer } from './console/server.ts';
import { Discovery } from './discover.ts';
import { Engine } from './engine.ts';
import { InviteTracker, type Invoker } from './invites.ts';
import { AnthropicLlm } from './llm.ts';
import { NewsRadar } from './news.ts';
import { Controller } from './controller.ts';
import { OwnerActions } from './owner-actions.ts';
import { MacNotifier, NullNotifier, type Notifier } from './notify.ts';
import { connectReader, type ReaderConnection } from './reader-client.ts';
import { Reader } from './reader.ts';
import { RecordingApi, RecordingLlm } from './recording.ts';
import { startScheduler } from './scheduler.ts';
import { Store } from './store.ts';
import { TermWatch } from './term-watch.ts';
import { TelegramApi, type BotCommand, type TgUser } from './telegram.ts';

const COMMANDS: Record<'en' | 'zh', BotCommand[]> = {
  en: [
    { command: 'digest', description: 'Digest the last 24h now' },
    { command: 'pulse', description: 'Status: messages recorded, next digest' },
    { command: 'rsi', description: 'How the digest is improving itself' },
    { command: 'feedback', description: 'Tell the digest what to do better' },
    { command: 'optout', description: 'Leave my messages out of digests' },
    { command: 'optin', description: 'Include my messages again' },
    { command: 'settings', description: 'Time, time zone, language, RSI mode (admins)' },
    { command: 'watch', description: 'Watch a public group or channel (owner, reader account)' },
    { command: 'sources', description: 'Watched groups and their state' },
    { command: 'help', description: 'All commands' },
  ],
  zh: [
    { command: 'digest', description: '立即总结最近 24 小时' },
    { command: 'pulse', description: '状态：已记录多少消息、下一份摘要时间' },
    { command: 'rsi', description: '摘要怎么改进自己' },
    { command: 'feedback', description: '告诉摘要哪里该改' },
    { command: 'optout', description: '摘要不收录我的消息' },
    { command: 'optin', description: '重新收录我的消息' },
    { command: 'settings', description: '时间、时区、语言、自我进化模式（管理员）' },
    { command: 'watch', description: '监控一个公开群或频道（部署者，需读者账号）' },
    { command: 'sources', description: '监控中的群和状态' },
    { command: 'help', description: '全部命令' },
  ],
};

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const now = () => Math.floor(Date.now() / 1000);

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const activity = new Activity(store);
  const startedAt = now();
  const claudeReady = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

  // The bot: optional. Without it, digests are kept in the console instead of sent.
  let telegram: TelegramApi | null = null;
  let me: TgUser | null = null;
  if (config.telegramToken) {
    telegram = new TelegramApi(config.telegramToken);
    me = await telegram.getMe();
    log(`bot @${me.username} · model ${config.model} · db ${config.dbPath} · ${store.listChats().length} chat(s)`);
    if (!me.can_read_all_group_messages) {
      log('note: privacy mode is on. Fine for report chats (DM or a report group); a group you run needs it off (@BotFather → /setprivacy → Disable) or the bot as admin.');
    }
    if (config.ownerIds.length === 0) {
      log('warning: PULSE_OWNER_IDS is empty, so anyone who finds the bot can add it to a group (and spend your API credits).');
    }
    await telegram.deleteWebhook();
    await telegram.setCommands(COMMANDS.en, { type: 'default' });
    await telegram.setCommands(COMMANDS.zh, { type: 'default' }, 'zh');
  } else {
    log('no TELEGRAM_BOT_TOKEN: console-only mode (digests are kept in the console, nothing is sent to Telegram)');
  }
  const api = new RecordingApi(telegram, store, activity);

  // The reader account: groups you do not run, read through a Telegram user session (see COOKBOOK.md).
  const defaults = { language: config.language, digestHour: config.digestHour, timezone: config.timezone, rsiMode: config.rsiMode };
  let reader: Reader | null = null;
  // Private groups by invite link: previews, the owner's word that they joined, the account's standing there.
  let invites: InviteTracker | null = null;
  let consoleUrl: string | null = null;
  const notifier: Notifier =
    config.notify && process.platform === 'darwin'
      ? new MacNotifier({
          enabled: true,
          showTitles: config.notifyTitles,
          onSent: (n) => activity.event('notify', 'notification shown', n.group ?? '', `${n.kind}: handed to macOS (Focus or notification settings can still hide it)`),
          onError: (err) => activity.event('notify', 'notification failed', 'macOS', `${err.message.slice(0, 200)} (allow notifications for Script Editor in System Settings)`, false),
        })
      : NullNotifier;
  // The news radar: first-tier news, turned into keywords of the day and matched against every
  // group message as it is stored. It needs no Telegram request of its own.
  const news = new NewsRadar({ store, config, now, log, activity, notifier, live: true });
  // The last thing this service recorded before this start (read before connecting, which records
  // requests itself). Claude's MCP server writes rows while the service is off: those do not count.
  const lastSeen = store.lastServiceActivity();
  const connection: ReaderConnection | null = config.telegramApiId
    ? await connectReader(config, log, { activity, titleOf: (id) => store.getChat(id)?.title ?? null }).catch((err) => {
        log(`reader: could not connect: ${(err as Error).message}`);
        return null;
      })
    : null;
  if (connection) {
    if (lastSeen && now() - lastSeen.at > 300) {
      const at = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
      activity.event('reader', 'was off', 'service', `not running from ${at(lastSeen.at)} to ${at(now())} UTC (${Math.round((now() - lastSeen.at) / 60)} min); fetching everything posted meanwhile`);
    }
    reader = new Reader({
      client: connection.client,
      store,
      config,
      log,
      now,
      activity,
      reconnect: connection.reconnect,
      // Follow the account's own chat list: what it joins in Telegram is read, what it leaves stops.
      discovery: {
        autoWatch: () => (store.getKv('auto_watch_new') || (config.autoWatchNew ? 'on' : 'off')) === 'on',
        reportTo: config.reportTo,
        defaults,
        onReconciled: (r, first) => invites?.onReconciled(r, first),
      },
      onBatch: (chatId, batch) => invites?.onBatch(chatId, batch),
      onStored: (chatId, messages) => news.onStored(chatId, messages),
      onAccessLost: (chatId, err) => invites?.onAccessLost(chatId, err) ?? Promise.resolve(),
    });
    const followed = reader;
    invites = new InviteTracker({
      raw: connection.raw as unknown as Invoker,
      reader,
      store,
      activity,
      config,
      notify: notifier,
      self: { id: connection.id, username: connection.username },
      defaults,
      now,
      consoleUrl: () => consoleUrl,
    });
    const tracker = invites;
    connection.onMembershipNotice((n) => {
      followed.membershipNotice(n);
      tracker.onNotice(n);
    });
    // Telegram pushes new messages for chats the account is in: read them within a second or two.
    connection.onLiveMessage((chatId) => followed.wake(chatId));
    log(`reader account: ${connection.name}`);
    activity.event('reader', 'signed in', connection.name, `Telegram id ${connection.id}`);
    if (config.ownerIds.length === 0) log('warning: the reader account is on but PULSE_OWNER_IDS is empty, so nobody can use /watch');
    for (const ref of config.watch) {
      if (config.reportTo === null) {
        log('PULSE_WATCH needs PULSE_REPORT_TO (or PULSE_OWNER_IDS) to know where to send the digests');
        break;
      }
      try {
        const info = await reader.resolve(ref);
        const known = store.getChat(info.chatId);
        if (known?.kind === 'watched') store.updateChat(info.chatId, { enabled: true });
        else store.watchChat(info, config.reportTo, null, defaults);
        log(`watching ${info.title} (${info.ref}) → chat ${store.getChat(info.chatId)!.reportChatId}`);
      } catch (err) {
        log(`PULSE_WATCH ${ref}: ${(err as Error).message}`);
      }
    }
  } else if (config.watch.length > 0) {
    log('PULSE_WATCH is set but the reader account is not signed in (TELEGRAM_API_ID / TELEGRAM_API_HASH, then npm run login)');
  }
  if (!telegram && !connection) {
    console.error(
      'Nothing to run. Either:\n' +
        '- sign in a reader account: TELEGRAM_API_ID / TELEGRAM_API_HASH in .env, then npm run login (see COOKBOOK.md), or\n' +
        '- create a bot with @BotFather and set TELEGRAM_BOT_TOKEN in .env.',
    );
    process.exit(1);
  }

  const llm = new RecordingLlm(new AnthropicLlm({ model: config.model }), activity);
  const engine = new Engine({ store, llm, config, api, now, log, reader });
  const bot = me ? new PulseBot({ store, engine, api, config, me, now, log, reader }) : null;
  let stopScheduler = () => undefined as void;
  if (claudeReady) stopScheduler = startScheduler(engine, store, { now, log });
  else log('no ANTHROPIC_API_KEY: messages are collected, but no digests are written until it is set');
  const stopReader = reader ? reader.start() : () => undefined;
  const stopInvites = invites ? invites.start() : () => undefined;
  const stopNews = news.start();
  // Short-term high-frequency terms: looked for every two minutes, each raised once (console, alerts).
  const stopTerms = new TermWatch({ store, activity, now }).start();
  if (config.news) log(`news radar: ${store.newsSources().filter((s) => s.enabled).length} sources (console → News radar)`);

  let consoleServer: ConsoleServer | null = null;
  const discovery = connection ? new Discovery({ store, activity, now, log, client: () => connection.raw }) : null;
  if (config.consolePort > 0) {
    consoleServer = new ConsoleServer({
      store,
      activity,
      config,
      port: config.consolePort,
      now,
      log,
      startedAt,
      account: connection ? { name: connection.name, id: connection.id, raw: connection.raw, state: connection.state, pushes: connection.pushes } : null,
      reader,
      bot: me?.username ? { username: me.username } : null,
      claude: { ready: claudeReady, model: config.model },
      // Next to the database, where the MCP server looks for it (data/console.json).
      handoffFile: join(dirname(config.dbPath), 'console.json'),
      invites,
      notifier,
      news,
      // Finding groups worth reading: through the same supervised client as the reading.
      discovery,
      // Joining and answering a group's check, on the owner's click only.
      owner: connection && invites ? new OwnerActions({ raw: connection.raw, permit: connection.permitWrite, store, activity, tracker: invites, now, likelyScams: () => discovery?.likelyScams() ?? new Set() }) : null,
      // The pad: the owner's hands on Telegram, one click per request (src/controller.ts).
      pad: connection
        ? new Controller({
            raw: connection.raw,
            permit: connection.permitWrite,
            store,
            activity,
            now,
            pullSoon: (chatId) => void setTimeout(() => void reader?.pullNow(chatId).catch(() => 0), 1500),
            listSoon: () => reader?.reconcileSoon(),
            held: connection.pausedUntil,
            online: () => connection.state().state === 'online',
          })
        : null,
      digestNow: (chatId) => {
        const chat = store.getChat(chatId);
        return engine.digest(chatId, { kind: 'manual', to: chat?.kind === 'watched' ? (chat.reportChatId ?? undefined) : undefined });
      },
    });
    try {
      await consoleServer.start();
      consoleUrl = consoleServer.url;
      log(`console: ${consoleServer.url}`);
    } catch (err) {
      log(`console: could not listen on 127.0.0.1:${config.consolePort} (${(err as Error).message}); set PULSE_CONSOLE_PORT to another port`);
      consoleServer = null;
    }
  }

  const purge = () => {
    const r = store.purgeBefore(now() - config.retentionDays * 86_400);
    const a = store.pruneActivity(now() - config.retentionDays * 86_400);
    store.pruneInvites(now());
    store.pruneNews(now() - config.retentionDays * 86_400);
    if (r.messages || r.shadows || a) log(`retention: deleted ${r.messages} messages, ${r.shadows} shadow digests and ${a} activity rows`);
  };
  purge();
  const purgeTimer = setInterval(purge, 3600_000);

  const abort = new AbortController();
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping`);
    abort.abort();
    stopScheduler();
    stopReader();
    stopInvites();
    stopNews();
    stopTerms();
    await consoleServer?.stop().catch(() => undefined);
    await connection?.disconnect().catch(() => undefined);
    clearInterval(purgeTimer);
    await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    store.close();
    process.exit(0);
  };
  // A stray rejected promise (GramJS update handlers can throw) is logged, not fatal.
  process.on('unhandledRejection', (err) => {
    log(`unhandled: ${(err as Error)?.stack ?? String(err)}`);
    activity.event('service', 'internal error', '', String((err as Error)?.message ?? err).slice(0, 300), false);
  });
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  // Closing its terminal tab: stop cleanly too, so the session lock is released.
  process.on('SIGHUP', () => void stop('SIGHUP'));

  if (!telegram || !bot) {
    await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve()));
    return;
  }
  let offset = Number(store.getKv('telegram_offset') ?? 0);
  while (!abort.signal.aborted) {
    let updates;
    try {
      updates = await api.getUpdates(offset, 50, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) break;
      log(`getUpdates: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      try {
        await bot.handle(u);
      } catch (err) {
        log(`update ${u.update_id}: ${(err as Error).stack ?? err}`);
      }
      offset = u.update_id + 1;
      store.setKv('telegram_offset', String(offset));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
