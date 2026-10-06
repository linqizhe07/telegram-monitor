// Wrappers that put what the bot sends and what Claude is asked into the activity log.

import type { Activity } from './activity.ts';
import type { Llm, LlmRequest, LlmUsage } from './llm.ts';
import type { Store } from './store.ts';
import type { BotCommand, InlineKeyboard, SendOptions, TelegramClient, TgMessage, TgUpdate, TgUser } from './telegram.ts';

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * The bot's Telegram client, recorded. With no bot token (`api` = null) nothing is sent: messages
 * are kept for the console instead, so digests can be read before a bot exists.
 */
export class RecordingApi implements TelegramClient {
  private readonly api: TelegramClient | null;
  private readonly store: Store;
  private readonly activity: Activity;

  constructor(api: TelegramClient | null, store: Store, activity: Activity) {
    this.api = api;
    this.store = store;
    this.activity = activity;
  }

  private need(): TelegramClient {
    if (!this.api) throw new Error('no bot token: TELEGRAM_BOT_TOKEN is not set');
    return this.api;
  }

  async getMe(): Promise<TgUser> {
    return this.need().getMe();
  }

  async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.need().getUpdates(offset, timeoutSeconds, signal);
  }

  async sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<TgMessage> {
    const preview = plain(text).slice(0, 140);
    if (!this.api) {
      const id = this.store.addOutbox(chatId, text, false);
      this.activity.event('bot', 'keep in console', `chat ${chatId}`, preview);
      return { message_id: -id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup' } };
    }
    try {
      const m = await this.api.sendMessage(chatId, text, opts);
      this.store.addOutbox(chatId, text, true);
      this.activity.event('bot', 'sendMessage', `chat ${chatId}`, preview);
      return m;
    } catch (err) {
      this.activity.event('bot', 'sendMessage', `chat ${chatId}`, (err as Error).message, false);
      throw err;
    }
  }

  async editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard): Promise<void> {
    if (this.api && messageId > 0) await this.api.editKeyboard(chatId, messageId, keyboard);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    if (this.api) await this.api.answerCallback(callbackId, text);
  }

  memberStatus(chatId: number, userId: number): Promise<string> {
    return this.api ? this.api.memberStatus(chatId, userId) : Promise.resolve('unknown');
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    if (this.api) await this.api.react(chatId, messageId, emoji);
  }

  async leaveChat(chatId: number): Promise<void> {
    if (this.api) await this.api.leaveChat(chatId);
  }

  async setCommands(commands: BotCommand[], scope: { type: string }, languageCode?: string): Promise<void> {
    if (this.api) await this.api.setCommands(commands, scope, languageCode);
  }

  async deleteWebhook(): Promise<void> {
    if (this.api) await this.api.deleteWebhook();
  }
}

/** Claude calls, recorded with their tokens and cost. */
export class RecordingLlm implements Llm {
  private readonly llm: Llm;
  private readonly activity: Activity;

  constructor(llm: Llm, activity: Activity) {
    this.llm = llm;
    this.activity = activity;
  }

  get model(): string {
    return this.llm.model;
  }

  async json<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const started = Date.now();
    try {
      const out = await this.llm.json(req);
      const u = out.usage;
      this.activity.record({
        actor: 'engine',
        kind: 'llm',
        method: req.role,
        target: u.model,
        detail: `${(u.inputTokens + u.cacheRead + u.cacheWrite).toLocaleString()} in · ${u.outputTokens.toLocaleString()} out${u.costUsd !== null ? ` · ~$${u.costUsd.toFixed(3)}` : ''}`,
        ms: Date.now() - started,
      });
      return out;
    } catch (err) {
      this.activity.record({ actor: 'engine', kind: 'llm', method: req.role, target: this.llm.model, detail: (err as Error).message, ok: false, ms: Date.now() - started });
      throw err;
    }
  }
}
