import { Activity } from './activity.ts';
import { PulseBot } from './bot.ts';
import { loadConfig } from './config.ts';
import { ConsoleServer } from './console/server.ts';
import { Engine } from './engine.ts';
import { AnthropicLlm } from './llm.ts';
import { connectReader, type ReaderConnection } from './reader-client.ts';
import { Reader } from './reader.ts';
import { RecordingApi, RecordingLlm } from './recording.ts';
import { startScheduler } from './scheduler.ts';
import { Store } from './store.ts';
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
  const connection: ReaderConnection | null = config.telegramApiId
    ? await connectReader(config, log, { activity, titleOf: (id) => store.getChat(id)?.title ?? null }).catch((err) => {
        log(`reader: could not connect: ${(err as Error).message}`);
        return null;
      })
    : null;
  if (connection) {
    reader = new Reader({ client: connection.client, store, config, log, now, activity, reconnect: connection.reconnect });
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

  let consoleServer: ConsoleServer | null = null;
  if (config.consolePort > 0) {
    consoleServer = new ConsoleServer({
      store,
      activity,
      config,
      port: config.consolePort,
      now,
      log,
      startedAt,
      account: connection ? { name: connection.name, id: connection.id, raw: connection.raw, state: connection.state } : null,
      reader,
      bot: me?.username ? { username: me.username } : null,
      claude: { ready: claudeReady, model: config.model },
      handoffFile: './data/console.json',
      digestNow: (chatId) => {
        const chat = store.getChat(chatId);
        return engine.digest(chatId, { kind: 'manual', to: chat?.kind === 'watched' ? (chat.reportChatId ?? undefined) : undefined });
      },
    });
    try {
      await consoleServer.start();
      log(`console: ${consoleServer.url}`);
    } catch (err) {
      log(`console: could not listen on 127.0.0.1:${config.consolePort} (${(err as Error).message}); set PULSE_CONSOLE_PORT to another port`);
      consoleServer = null;
    }
  }

  const purge = () => {
    const r = store.purgeBefore(now() - config.retentionDays * 86_400);
    const a = store.pruneActivity(now() - config.retentionDays * 86_400);
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
    await consoleServer?.stop().catch(() => undefined);
    await connection?.disconnect().catch(() => undefined);
    clearInterval(purgeTimer);
    await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

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
