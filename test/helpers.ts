import { loadConfig, type Config } from '../src/config.ts';
import type { StoredMessage } from '../src/store.ts';
import { Store } from '../src/store.ts';
import type {
  BotCommand,
  InlineKeyboard,
  SendOptions,
  TelegramClient,
  TgMessage,
  TgUpdate,
  TgUser,
} from '../src/telegram.ts';

export const CHAT = -1001234567890;
export const T0 = Date.UTC(2026, 9, 4, 1, 0) / 1000; // 2026-10-04 09:00 Asia/Shanghai

export function testConfig(over: Partial<Config> = {}): Config {
  return { ...loadConfig({ TELEGRAM_BOT_TOKEN: 'test' }), rsiMinMessages: 10, ...over };
}

export class Clock {
  t: number;
  constructor(t = T0) {
    this.t = t;
  }
  now = () => this.t;
}

export function memoryStore(clock: Clock): Store {
  return new Store(':memory:', clock.now);
}

/** Records everything the bot sends. */
export class FakeTelegram implements TelegramClient {
  sent: { chatId: number; text: string; opts: SendOptions; id: number }[] = [];
  keyboards: { chatId: number; messageId: number; keyboard: InlineKeyboard }[] = [];
  answers: { id: string; text?: string }[] = [];
  reactions: { chatId: number; messageId: number; emoji: string }[] = [];
  left: number[] = [];
  statuses = new Map<string, string>();
  private nextId = 10_000;

  async getMe(): Promise<TgUser> {
    return { id: 42, is_bot: true, first_name: 'Pulse', username: 'pulse_bot', can_read_all_group_messages: true };
  }
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    const id = this.nextId++;
    this.sent.push({ chatId, text, opts, id });
    return { message_id: id, date: 0, chat: { id: chatId, type: 'supergroup' }, text };
  }
  async editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard): Promise<void> {
    this.keyboards.push({ chatId, messageId, keyboard });
  }
  async answerCallback(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }
  async memberStatus(chatId: number, userId: number): Promise<string> {
    return this.statuses.get(`${chatId}:${userId}`) ?? 'member';
  }
  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }
  async leaveChat(chatId: number): Promise<void> {
    this.left.push(chatId);
  }
  async setCommands(_c: BotCommand[], _s: { type: string }): Promise<void> {}
  async deleteWebhook(): Promise<void> {}

  last(): { chatId: number; text: string; opts: SendOptions; id: number } {
    return this.sent[this.sent.length - 1];
  }
}

const NAMES = ['老王', 'Kevin', '阿杰', 'Momo', 'Ray', 'Ivy', 'Hank', 'Nate'];

/**
 * A day of chat with `threads` reply threads (each 4 messages, 3 people, a pain-point keyword
 * in one), plus some noise, starting at `start`.
 */
export function syntheticDay(chatId: number, start: number, firstId: number, threads = 6): StoredMessage[] {
  const out: StoredMessage[] = [];
  let id = firstId;
  let t = start + 600;
  for (let k = 0; k < threads; k++) {
    const root = id;
    const users = [1 + (k % 8), 1 + ((k + 1) % 8), 1 + ((k + 2) % 8)];
    const lines = [
      `话题${k}：agent 的 API key 权限问题第${k}次被提出，交易和提币绑在一起`,
      `同意，这个问题我们也遇到了，卡了很久 (${k})`,
      `要不要做个限额代理，想法是按币种和金额限制 (${k})`,
      `这其实是个机会，没人做这个空白 (${k})`,
    ];
    for (const [i, text] of lines.entries()) {
      out.push({
        chatId,
        messageId: id++,
        threadId: null,
        userId: users[i % 3],
        date: (t += 60),
        text,
        replyTo: i === 0 ? null : root,
        reactions: i === 0 ? k + 1 : 0,
        edited: false,
      });
    }
    t += 1800;
  }
  for (let n = 0; n < 4; n++) {
    out.push({ chatId, messageId: id++, threadId: null, userId: 1 + (n % 8), date: (t += 1300), text: 'gm', replyTo: null, reactions: 0, edited: false });
  }
  return out;
}

export function seedUsers(store: Store, chatId: number): void {
  NAMES.forEach((name, i) => store.upsertUser(chatId, i + 1, name, null));
}

export function seedChat(store: Store, chatId = CHAT, over: { rsiMode?: 'auto' | 'propose' | 'off' } = {}) {
  return store.upsertChat(
    { chatId, title: 'Alpha Builders 研究群', username: null, type: 'supergroup' },
    { language: 'auto', digestHour: 9, timezone: 'Asia/Shanghai', rsiMode: over.rsiMode ?? 'auto' },
  );
}

let updateId = 1;
export function groupMessage(p: {
  id: number;
  from: Partial<TgUser> & { id: number };
  text?: string;
  date?: number;
  replyTo?: TgMessage;
  chatId?: number;
  extra?: Partial<TgMessage>;
}): TgUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: p.id,
      date: p.date ?? T0,
      chat: { id: p.chatId ?? CHAT, type: 'supergroup', title: 'Alpha Builders 研究群' },
      from: { is_bot: false, first_name: `user${p.from.id}`, ...p.from },
      text: p.text,
      reply_to_message: p.replyTo,
      ...p.extra,
    },
  };
}
