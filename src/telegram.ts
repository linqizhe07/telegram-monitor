// A small Telegram Bot API client over fetch (long polling, no webhook, no dependencies).

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  /** Only on getMe: false while privacy mode is on. */
  can_read_all_group_messages?: boolean;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  is_forum?: boolean;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  sender_chat?: TgChat;
  date: number;
  chat: TgChat;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  edit_date?: number;
  forward_origin?: { type: string; sender_user?: TgUser; sender_user_name?: string; chat?: TgChat; sender_chat?: TgChat };
  photo?: unknown[];
  video?: unknown;
  animation?: unknown;
  voice?: { duration: number };
  video_note?: { duration: number };
  audio?: { title?: string; duration: number };
  document?: { file_name?: string };
  sticker?: { emoji?: string };
  poll?: { question: string };
  location?: unknown;
  contact?: unknown;
  new_chat_members?: TgUser[];
  left_chat_member?: TgUser;
  migrate_to_chat_id?: number;
  forum_topic_created?: { name: string };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  date: number;
  old_chat_member: { status: string; user: TgUser };
  new_chat_member: { status: string; user: TgUser };
}

export interface TgReactionType {
  type: string;
  emoji?: string;
}

export interface TgMessageReactionUpdated {
  chat: TgChat;
  message_id: number;
  user?: TgUser;
  date: number;
  old_reaction: TgReactionType[];
  new_reaction: TgReactionType[];
}

export interface TgMessageReactionCountUpdated {
  chat: TgChat;
  message_id: number;
  date: number;
  reactions: { type: TgReactionType; total_count: number }[];
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
  message_reaction?: TgMessageReactionUpdated;
  message_reaction_count?: TgMessageReactionCountUpdated;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}
export type InlineKeyboard = InlineButton[][];

export interface SendOptions {
  threadId?: number | null;
  replyTo?: number;
  keyboard?: InlineKeyboard;
  /** Plain text instead of HTML. */
  plain?: boolean;
  silent?: boolean;
}

export interface BotCommand {
  command: string;
  description: string;
}

/** What the bot needs from Telegram. TelegramApi talks to the real API; tests use a fake. */
export interface TelegramClient {
  getMe(): Promise<TgUser>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<TgMessage>;
  editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  memberStatus(chatId: number, userId: number): Promise<string>;
  react(chatId: number, messageId: number, emoji: string): Promise<void>;
  leaveChat(chatId: number): Promise<void>;
  setCommands(commands: BotCommand[], scope: { type: string }, languageCode?: string): Promise<void>;
  deleteWebhook(): Promise<void>;
}

export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'message_reaction',
  'message_reaction_count',
];

export class TelegramError extends Error {
  readonly method: string;
  readonly code: number;
  constructor(method: string, code: number, description: string) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.code = code;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApi implements TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, opts: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Never let the token reach a log line. */
  private redact(s: string): string {
    return this.token ? s.split(this.token).join('<token>') : s;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new TelegramError(method, 0, this.redact(String((err as Error).message ?? err)));
      }
      const body = (await res.json().catch(() => null)) as ApiResponse<T> | null;
      if (body?.ok) return body.result as T;
      const retryAfter = body?.parameters?.retry_after;
      if (res.status === 429 && retryAfter !== undefined && attempt < 3) {
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new TelegramError(method, body?.error_code ?? res.status, this.redact(body?.description ?? res.statusText));
    }
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe');
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ALLOWED_UPDATES }, signal);
  }

  sendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    };
    if (!opts.plain) params.parse_mode = 'HTML';
    if (opts.threadId) params.message_thread_id = opts.threadId;
    if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts.keyboard) params.reply_markup = { inline_keyboard: opts.keyboard };
    if (opts.silent) params.disable_notification = true;
    return this.call('sendMessage', params);
  }

  async editKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      // Pressing a button that produces the same counts is not an error worth surfacing.
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err;
    }
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async memberStatus(chatId: number, userId: number): Promise<string> {
    const m = await this.call<{ status: string }>('getChatMember', { chat_id: chatId, user_id: userId });
    return m.status;
  }

  async react(chatId: number, messageId: number, emoji: string): Promise<void> {
    await this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
  }

  async leaveChat(chatId: number): Promise<void> {
    await this.call('leaveChat', { chat_id: chatId });
  }

  async setCommands(commands: BotCommand[], scope: { type: string }, languageCode?: string): Promise<void> {
    await this.call('setMyCommands', { commands, scope, ...(languageCode ? { language_code: languageCode } : {}) });
  }

  async deleteWebhook(): Promise<void> {
    await this.call('deleteWebhook', { drop_pending_updates: false });
  }
}

/** Link to a message, when the chat type allows one. */
export function messageLink(chat: { chatId: number; username: string | null }, messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.chatId);
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}/${messageId}`;
  return null; // basic groups have no message links
}
