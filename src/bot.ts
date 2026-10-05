import { isValidTimezone, type Config } from './config.ts';
import type { Engine } from './engine.ts';
import { strings, type UiLang } from './i18n.ts';
import { SEED_PLAYBOOK } from './prompts.ts';
import { escapeHtml, voteKeyboard } from './render.ts';
import { PROBATION_DIGESTS } from './rsi/evolve.ts';
import type { ChatRow, Store } from './store.ts';
import type {
  TelegramClient,
  TgCallbackQuery,
  TgChat,
  TgChatMemberUpdated,
  TgMessage,
  TgMessageReactionCountUpdated,
  TgMessageReactionUpdated,
  TgUpdate,
  TgUser,
} from './telegram.ts';
import { lastSlot, localDate, localTime, detectLanguage } from './transcript.ts';

export interface BotDeps {
  store: Store;
  engine: Engine;
  api: TelegramClient;
  config: Config;
  me: TgUser;
  now: () => number;
  log: (line: string) => void;
}

export interface Command {
  name: string;
  args: string;
  /** Addressed to another bot (/cmd@other_bot). */
  forOther: boolean;
}

export function parseCommand(text: string, botUsername: string | undefined): Command | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const target = m[2];
  return {
    name: m[1].toLowerCase(),
    args: (m[3] ?? '').trim(),
    forOther: Boolean(target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()),
  };
}

export const fullName = (u: { first_name: string; last_name?: string; username?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || 'someone';

const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** What a message says, as one line of text. Media becomes a tag; phone numbers and coordinates are never copied. */
export function describeMessage(m: TgMessage): string | null {
  const parts: string[] = [];
  const o = m.forward_origin;
  if (o) {
    const source = o.chat?.title ?? o.sender_chat?.title;
    parts.push(source ? `[forwarded from ${source}]` : '[forwarded]');
  }
  if (m.photo) parts.push('[photo]');
  else if (m.video) parts.push('[video]');
  else if (m.animation) parts.push('[gif]');
  else if (m.voice) parts.push(`[voice ${duration(m.voice.duration)}]`);
  else if (m.video_note) parts.push('[video note]');
  else if (m.audio) parts.push(m.audio.title ? `[audio: ${m.audio.title}]` : '[audio]');
  else if (m.document) parts.push(m.document.file_name ? `[document: ${m.document.file_name}]` : '[document]');
  else if (m.sticker) parts.push(m.sticker.emoji ? `[sticker ${m.sticker.emoji}]` : '[sticker]');
  else if (m.poll) parts.push(`[poll: ${m.poll.question}]`);
  else if (m.location) parts.push('[location]');
  else if (m.contact) parts.push('[contact]');
  const body = (m.text ?? m.caption ?? '').trim();
  if (body) parts.push(body);
  return parts.length ? parts.join(' ') : null;
}

const ADMIN_TTL = 600;

export class PulseBot {
  private readonly deps: BotDeps;
  private readonly adminCache = new Map<string, { ok: boolean; at: number }>();
  private readonly lastManual = new Map<number, number>();

  constructor(deps: BotDeps) {
    this.deps = deps;
  }

  async handle(u: TgUpdate): Promise<void> {
    if (u.message) return this.onMessage(u.message);
    if (u.edited_message) return this.onEdit(u.edited_message);
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.my_chat_member) return this.onMembership(u.my_chat_member);
    if (u.message_reaction) return this.onReaction(u.message_reaction);
    if (u.message_reaction_count) return this.onReactionCount(u.message_reaction_count);
  }

  private ensureChat(c: TgChat): ChatRow {
    const { store, config } = this.deps;
    const row = store.upsertChat(
      { chatId: c.id, title: c.title ?? String(c.id), username: c.username ?? null, type: c.type },
      { language: config.language, digestHour: config.digestHour, timezone: config.timezone, rsiMode: config.rsiMode },
    );
    if (!row.enabled) store.updateChat(c.id, { enabled: true });
    return row;
  }

  private lang(chat: ChatRow): UiLang {
    return this.deps.engine.uiLang(chat);
  }

  private reply(m: TgMessage, html: string): Promise<unknown> {
    return this.deps.api
      .sendMessage(m.chat.id, html, { replyTo: m.message_id, threadId: m.is_topic_message ? m.message_thread_id : undefined })
      .catch((err) => this.deps.log(`reply failed in ${m.chat.id}: ${(err as Error).message}`));
  }

  private async isAdmin(chatId: number, userId: number): Promise<boolean> {
    if (this.deps.config.ownerIds.includes(userId)) return true;
    if (userId === chatId) return true; // an anonymous admin posts as the group itself
    const key = `${chatId}:${userId}`;
    const hit = this.adminCache.get(key);
    const now = this.deps.now();
    // "Yes" is cached for 10 minutes, "no" for one, so a newly promoted admin is not kept waiting.
    if (hit && now - hit.at < (hit.ok ? ADMIN_TTL : 60)) return hit.ok;
    const status = await this.deps.api.memberStatus(chatId, userId).catch(() => 'unknown');
    const ok = status === 'creator' || status === 'administrator';
    this.adminCache.set(key, { ok, at: now });
    return ok;
  }

  // ── messages ─────────────────────────────────────────────────────────────

  private async onMessage(m: TgMessage): Promise<void> {
    const { store, me } = this.deps;
    if (m.chat.type === 'private') return this.onPrivate(m);
    if (m.chat.type !== 'group' && m.chat.type !== 'supergroup') return;
    if (m.migrate_to_chat_id) {
      this.deps.log(`chat ${m.chat.id} became supergroup ${m.migrate_to_chat_id}`);
      store.updateChat(m.chat.id, { enabled: false });
      return;
    }
    const chat = this.ensureChat(m.chat);

    // Author: a person, an anonymous admin (posting as the group), or a linked channel.
    let author: { id: number; name: string; username: string | null };
    if (m.sender_chat) author = { id: m.sender_chat.id, name: m.sender_chat.title ?? 'channel', username: m.sender_chat.username ?? null };
    else if (m.from && !m.from.is_bot) author = { id: m.from.id, name: fullName(m.from), username: m.from.username ?? null };
    else return; // bots, including this one

    const text = m.text ?? m.caption ?? '';
    const cmd = text.startsWith('/') ? parseCommand(text, me.username) : null;
    if (cmd) {
      if (!cmd.forOther) await this.onCommand(m, cmd, chat, author.id);
      return;
    }

    // A reply to one of our digests is feedback on it, not group conversation.
    if (m.reply_to_message?.from?.id === me.id) {
      const digest = store.digestByPostedMessage(chat.chatId, m.reply_to_message.message_id);
      if (digest && text.trim()) {
        store.addFeedback(chat.chatId, digest.id, author.id, text.trim());
        await this.deps.api.react(chat.chatId, m.message_id, '✍').catch(() => undefined);
      }
      return;
    }

    if (store.isOptedOut(chat.chatId, author.id)) return;
    const content = describeMessage(m);
    if (!content) return; // service messages
    store.upsertUser(chat.chatId, author.id, author.name, author.username);
    store.saveMessage({
      chatId: chat.chatId,
      messageId: m.message_id,
      threadId: m.is_topic_message ? (m.message_thread_id ?? null) : null,
      userId: author.id,
      date: m.date,
      text: content,
      replyTo: m.reply_to_message && !m.reply_to_message.forum_topic_created ? m.reply_to_message.message_id : null,
      reactions: 0,
      edited: false,
    });
  }

  private onEdit(m: TgMessage): void {
    if (m.chat.type !== 'group' && m.chat.type !== 'supergroup') return;
    const content = describeMessage(m);
    if (content) this.deps.store.editMessage(m.chat.id, m.message_id, content);
  }

  private async onPrivate(m: TgMessage): Promise<void> {
    if (!m.from || m.from.is_bot) return;
    const lang: UiLang = (m.from as TgUser & { language_code?: string }).language_code?.startsWith('zh') ? 'zh' : 'en';
    await this.deps.api.sendMessage(m.chat.id, strings(lang).privateStart(m.from.id)).catch(() => undefined);
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private async onCommand(m: TgMessage, cmd: Command, chat: ChatRow, userId: number): Promise<void> {
    const { store, engine, config, api } = this.deps;
    const s = strings(this.lang(chat));
    const threadId = m.is_topic_message ? (m.message_thread_id ?? null) : null;

    switch (cmd.name) {
      case 'digest': {
        const hours = Math.min(Math.max(Number.parseInt(cmd.args, 10) || 24, 1), config.retentionDays * 24);
        const now = this.deps.now();
        const last = this.lastManual.get(chat.chatId) ?? 0;
        const wait = config.manualCooldownMinutes * 60 - (now - last);
        if (wait > 0 && !(await this.isAdmin(chat.chatId, userId))) {
          await this.reply(m, s.cooldown(Math.ceil(wait / 60)));
          return;
        }
        this.lastManual.set(chat.chatId, now);
        await api.react(chat.chatId, m.message_id, '👀').catch(() => this.reply(m, s.working(hours)));
        void engine.digest(chat.chatId, { kind: 'manual', hours, replyTo: m.message_id, threadId });
        return;
      }
      case 'pulse':
      case 'status': {
        const now = this.deps.now();
        const recent = store.messages(chat.chatId, now - 86_400, now + 1);
        const next = lastSlot(now, chat.timezone, chat.digestHour) + 86_400;
        const champion = store.champion(chat.chatId, SEED_PLAYBOOK);
        await this.reply(
          m,
          s.status({
            title: escapeHtml(chat.title),
            messages: recent.length,
            people: new Set(recent.map((x) => x.userId)).size,
            next: `${localDate(next, chat.timezone)} ${localTime(next, chat.timezone)} (${chat.timezone})`,
            version: champion.version,
            mode: s.modes[chat.rsiMode],
            days: config.retentionDays,
          }),
        );
        return;
      }
      case 'rsi':
        return this.onRsi(m, cmd, chat, userId, threadId);
      case 'feedback': {
        if (!cmd.args) {
          await this.reply(m, s.feedbackUsage);
          return;
        }
        store.addFeedback(chat.chatId, store.latestPosted(chat.chatId)?.id ?? null, userId, cmd.args);
        await this.reply(m, s.feedbackThanks);
        return;
      }
      case 'optout': {
        if (store.isOptedOut(chat.chatId, userId)) {
          await this.reply(m, s.alreadyOptedOut);
          return;
        }
        await this.reply(m, s.optedOut(store.optOut(chat.chatId, userId)));
        return;
      }
      case 'optin':
        store.optIn(chat.chatId, userId);
        await this.reply(m, s.optedIn);
        return;
      case 'settings':
        return this.onSettings(m, cmd, chat, userId, threadId);
      case 'help':
      case 'start':
        await this.reply(m, s.help);
        return;
      default:
        return; // not ours
    }
  }

  private async onRsi(m: TgMessage, cmd: Command, chat: ChatRow, userId: number, threadId: number | null): Promise<void> {
    const { store, engine } = this.deps;
    const s = strings(this.lang(chat));
    const [sub, arg] = cmd.args.split(/\s+/);
    const admin = () => this.isAdmin(chat.chatId, userId);

    if (sub === 'playbook') {
      const g = store.champion(chat.chatId, SEED_PLAYBOOK);
      await this.reply(m, `🧬 <b>playbook v${g.version}</b>\n<blockquote expandable>${escapeHtml(g.playbook)}</blockquote>`);
      return;
    }
    if (sub === 'evolve') {
      if (!(await admin())) return void (await this.reply(m, s.adminOnly));
      await this.reply(m, s.evolving);
      void engine.evolve(chat.chatId, { force: true, replyTo: m.message_id, threadId });
      return;
    }
    if (sub === 'rollback') {
      if (!(await admin())) return void (await this.reply(m, s.adminOnly));
      const to = arg ? Number.parseInt(arg.replace(/^v/i, ''), 10) : undefined;
      await this.reply(m, engine.rollback(chat.chatId, Number.isFinite(to) ? to : undefined));
      return;
    }

    const now = this.deps.now();
    const champion = store.champion(chat.chatId, SEED_PLAYBOOK);
    const cost = store.costSince(chat.chatId, now - 7 * 86_400);
    const lines = [
      s.rsiHeader({
        version: champion.version,
        since: champion.promotedAt && champion.parent !== null ? localDate(champion.promotedAt, chat.timezone) : '',
        mode: s.modes[chat.rsiMode],
        cost: `$${(cost.digest + cost.rsi).toFixed(2)} (digest $${cost.digest.toFixed(2)} · RSI $${cost.rsi.toFixed(2)})`,
      }),
      '',
    ];
    const lineage = store.genomes(chat.chatId, 8).filter((g) => g.operator !== 'seed');
    if (lineage.length === 0) lines.push(s.rsiNoLineage);
    for (const g of lineage) {
      const ok = g.status === 'champion' || g.status === 'retired';
      const why = g.status === 'vetoed' ? '👎' : g.status === 'pending' ? '⏳' : g.status === 'champion' ? '★' : '';
      lines.push(escapeHtml(s.rsiLine({ version: g.version, operator: g.operator, ok, summary: g.summary, why })));
      if (g.rationale) lines.push(`   <i>${escapeHtml(g.rationale.slice(0, 200))}</i>`);
    }
    const t = store.tallyForVersion(chat.chatId, champion.version);
    lines.push('', s.rsiVotes(t.up, t.down));
    if (champion.parent !== null && t.digests <= PROBATION_DIGESTS) lines.push(`(probation: ${t.digests}/${PROBATION_DIGESTS})`);
    if (chat.improverNotes.trim()) {
      lines.push('', s.rsiNotes, `<blockquote expandable>${escapeHtml(chat.improverNotes.trim())}</blockquote>`);
    }
    lines.push('', `<i>${s.rsiFooter}</i>`);
    await this.reply(m, lines.join('\n'));
  }

  private async onSettings(m: TgMessage, cmd: Command, chat: ChatRow, userId: number, threadId: number | null): Promise<void> {
    const { store } = this.deps;
    const s = strings(this.lang(chat));
    const show = () =>
      this.reply(
        m,
        s.settings({
          hour: chat.digestHour,
          timezone: chat.timezone,
          language: s.langNames[chat.language],
          mode: s.modes[chat.rsiMode],
          here: chat.threadId !== null,
        }),
      );
    if (!cmd.args) return void (await show());
    if (!(await this.isAdmin(chat.chatId, userId))) return void (await this.reply(m, s.adminOnly));

    const [key, value = ''] = cmd.args.split(/\s+/);
    const v = value.trim();
    let ok = true;
    switch (key) {
      case 'hour': {
        const h = Number.parseInt(v, 10);
        ok = Number.isInteger(h) && h >= 0 && h <= 23;
        if (ok) store.updateChat(chat.chatId, { digestHour: h, lastDigestAt: this.deps.now() });
        break;
      }
      case 'tz':
        ok = isValidTimezone(v);
        if (ok) store.updateChat(chat.chatId, { timezone: v, lastDigestAt: this.deps.now() });
        break;
      case 'lang':
        ok = v === 'auto' || v === 'en' || v === 'zh';
        if (ok) store.updateChat(chat.chatId, { language: v as ChatRow['language'] });
        break;
      case 'rsi':
        ok = v === 'auto' || v === 'propose' || v === 'off';
        if (ok) store.updateChat(chat.chatId, { rsiMode: v as ChatRow['rsiMode'] });
        break;
      case 'here':
        store.updateChat(chat.chatId, { threadId });
        break;
      default:
        ok = false;
    }
    await this.reply(m, ok ? s.settingsSaved : s.settingsBad);
  }

  // ── buttons ──────────────────────────────────────────────────────────────

  private async onCallback(q: TgCallbackQuery): Promise<void> {
    const { store, api, engine } = this.deps;
    const msg = q.message;
    const data = q.data ?? '';
    if (!msg) return void (await api.answerCallback(q.id));
    const chat = store.getChat(msg.chat.id);
    if (!chat) return void (await api.answerCallback(q.id));
    const s = strings(this.lang(chat));

    const vote = /^v:(\d+):(-?1)$/.exec(data);
    if (vote) {
      const digestId = Number(vote[1]);
      const digest = store.digest(digestId);
      if (!digest || digest.chatId !== chat.chatId) return void (await api.answerCallback(q.id));
      const value = store.vote(digestId, q.from.id, Number(vote[2]) as 1 | -1);
      const lang = digest.digest.headline && detectLanguage([digest.digest.headline]) === 'zh' ? 'zh' : this.lang(chat);
      await api.editKeyboard(chat.chatId, msg.message_id, voteKeyboard(lang, digestId, store.tally(digestId))).catch(() => undefined);
      await api.answerCallback(q.id, value === 0 ? s.voteCleared : s.voteRecorded);
      await engine.afterVote(chat.chatId);
      return;
    }

    const decision = /^g:(\d+):([01])$/.exec(data);
    if (decision) {
      if (!(await this.isAdmin(chat.chatId, q.from.id))) return void (await api.answerCallback(q.id, s.adminOnly));
      const text = await engine.decide(chat.chatId, Number(decision[1]), decision[2] === '1');
      await api.editKeyboard(chat.chatId, msg.message_id, []).catch(() => undefined);
      await api.answerCallback(q.id);
      if (text) await engine.send(chat, text);
      return;
    }
    await api.answerCallback(q.id);
  }

  // ── membership and reactions ─────────────────────────────────────────────

  private async onMembership(u: TgChatMemberUpdated): Promise<void> {
    const { store, api, config, me, log } = this.deps;
    if (u.new_chat_member.user.id !== me.id) return;
    if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return;
    const now = u.new_chat_member.status;
    const was = u.old_chat_member.status;
    const present = (st: string) => st === 'member' || st === 'administrator' || st === 'restricted';

    if (!present(now)) {
      store.updateChat(u.chat.id, { enabled: false });
      log(`removed from ${u.chat.id} (${u.chat.title ?? ''})`);
      return;
    }
    if (present(was)) return; // promoted/demoted, still here

    if (config.ownerIds.length > 0 && !config.ownerIds.includes(u.from.id)) {
      const lang: UiLang = detectLanguage([u.chat.title ?? '']) === 'zh' ? 'zh' : 'en';
      await api.sendMessage(u.chat.id, strings(lang).privateInstance).catch(() => undefined);
      await api.leaveChat(u.chat.id).catch(() => undefined);
      log(`left ${u.chat.id}: added by ${u.from.id}, who is not an owner`);
      return;
    }
    const chat = this.ensureChat(u.chat);
    const s = strings(this.lang(chat));
    log(`added to ${u.chat.id} (${u.chat.title ?? ''}) by ${u.from.id}`);
    await api.sendMessage(u.chat.id, s.intro(config.retentionDays)).catch(() => undefined);
    if (!me.can_read_all_group_messages && now !== 'administrator') {
      await api.sendMessage(u.chat.id, s.cannotRead).catch(() => undefined);
    }
  }

  private onReaction(r: TgMessageReactionUpdated): void {
    const delta = r.new_reaction.length - r.old_reaction.length;
    if (delta !== 0) this.deps.store.addReactions(r.chat.id, r.message_id, delta);
  }

  private onReactionCount(r: TgMessageReactionCountUpdated): void {
    this.deps.store.setReactions(r.chat.id, r.message_id, r.reactions.reduce((sum, x) => sum + x.total_count, 0));
  }
}
