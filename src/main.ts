import { PulseBot } from './bot.ts';
import { loadConfig } from './config.ts';
import { Engine } from './engine.ts';
import { AnthropicLlm } from './llm.ts';
import { startScheduler } from './scheduler.ts';
import { Store } from './store.ts';
import { TelegramApi, type BotCommand } from './telegram.ts';

const COMMANDS: Record<'en' | 'zh', BotCommand[]> = {
  en: [
    { command: 'digest', description: 'Digest the last 24h now' },
    { command: 'pulse', description: 'Status: messages recorded, next digest' },
    { command: 'rsi', description: 'How the digest is improving itself' },
    { command: 'feedback', description: 'Tell the digest what to do better' },
    { command: 'optout', description: 'Leave my messages out of digests' },
    { command: 'optin', description: 'Include my messages again' },
    { command: 'settings', description: 'Time, time zone, language, RSI mode (admins)' },
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
    { command: 'help', description: '全部命令' },
  ],
};

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const now = () => Math.floor(Date.now() / 1000);

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.telegramToken) {
    console.error(
      'TELEGRAM_BOT_TOKEN is not set.\n' +
        '1. Create a bot with @BotFather (/newbot) and copy its token.\n' +
        '2. In @BotFather: /setprivacy → choose the bot → Disable (so it can read group messages).\n' +
        '3. cp .env.example .env, fill in TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY, then npm start.',
    );
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    log('note: ANTHROPIC_API_KEY is not set; the Claude SDK will look for an `ant auth login` profile instead');
  }

  const store = new Store(config.dbPath);
  const api = new TelegramApi(config.telegramToken);
  const me = await api.getMe();
  log(`signed in as @${me.username} · model ${config.model} · db ${config.dbPath} · ${store.listChats().length} group(s)`);
  if (!me.can_read_all_group_messages) {
    log('warning: privacy mode is on, so the bot only sees commands in groups where it is not an admin. @BotFather → /setprivacy → Disable.');
  }
  if (config.ownerIds.length === 0) {
    log('warning: PULSE_OWNER_IDS is empty, so anyone who finds the bot can add it to a group (and spend your API credits).');
  }
  await api.deleteWebhook();
  await api.setCommands(COMMANDS.en, { type: 'default' });
  await api.setCommands(COMMANDS.zh, { type: 'default' }, 'zh');

  const llm = new AnthropicLlm({ model: config.model });
  const engine = new Engine({ store, llm, config, api, now, log });
  const bot = new PulseBot({ store, engine, api, config, me, now, log });
  const stopScheduler = startScheduler(engine, store, { now, log });

  const purge = () => {
    const r = store.purgeBefore(now() - config.retentionDays * 86_400);
    if (r.messages || r.shadows) log(`retention: deleted ${r.messages} messages and ${r.shadows} shadow digests`);
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
    clearInterval(purgeTimer);
    await Promise.race([engine.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

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
