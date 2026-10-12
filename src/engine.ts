import type { Config } from './config.ts';
import { digestLanguage, produceDigest, streaks } from './digest.ts';
import { strings, type UiLang } from './i18n.ts';
import { LlmError, type Llm } from './llm.ts';
import { SEED_PLAYBOOK } from './prompts.ts';
import { aliasNames, approvalKeyboard, escapeHtml, renderDigest, voteKeyboard } from './render.ts';
import { checkVeto, evolve, type EvolveReport } from './rsi/evolve.ts';
import type { ChatRow, Store } from './store.ts';
import type { InlineKeyboard, TelegramClient } from './telegram.ts';
import { detectLanguage, type Window } from './transcript.ts';

export interface EngineDeps {
  store: Store;
  llm: Llm;
  config: Config;
  api: TelegramClient;
  now: () => number;
  log: (line: string) => void;
  /**
   * The reader account, when one is signed in. Before a watched chat's digest it catches up (so
   * messages posted while the service was offline are in) and refreshes reactions and edits.
   */
  reader?: { refresh(chat: ChatRow, window: Window): Promise<void>; catchUp?(chat: ChatRow): Promise<boolean> } | null;
  /** Discord sources catch up through the Discord bot, never the Telegram reader. */
  discord?: { catchUp(chat: ChatRow): Promise<boolean> } | null;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

export function describeError(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

/** Digests and self-improvement for every group; one task at a time per group. */
export class Engine {
  private readonly deps: EngineDeps;
  private readonly queues = new Map<number, Promise<unknown>>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  private serial<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.queues.set(
      chatId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Waits for everything queued so far (used on shutdown and in tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  /** Language for the bot's own messages: the group's setting, else what its members write. */
  uiLang(chat: ChatRow): UiLang {
    if (chat.language !== 'auto') return chat.language;
    const now = this.deps.now();
    const recent = this.deps.store.messages(chat.chatId, now - 3 * 86_400, now + 1).slice(-300);
    if (recent.length > 0) return detectLanguage(recent.map((m) => m.text));
    return detectLanguage([chat.title]) === 'zh' || this.deps.config.language === 'zh' ? 'zh' : 'en';
  }

  /** Where a chat's digests and announcements go: the group itself, or the report chat of a watched one. */
  destination(chat: ChatRow): number {
    return chat.reportChatId ?? chat.chatId;
  }

  /** Posts to `opts.to` (the chat a command came from), else to the chat's destination. */
  async send(
    chat: ChatRow,
    html: string,
    opts: { replyTo?: number; keyboard?: InlineKeyboard; threadId?: number | null; to?: number } = {},
  ): Promise<number> {
    const to = opts.to ?? this.destination(chat);
    const m = await this.deps.api.sendMessage(to, html, {
      threadId: opts.threadId !== undefined ? opts.threadId : opts.to !== undefined ? null : chat.threadId,
      replyTo: opts.replyTo,
      keyboard: opts.keyboard,
    });
    return m.message_id;
  }

  /**
   * Writes and posts a digest of the `hours` before `end`.
   * production = the scheduled daily digest (an evaluation window for RSI); manual = /digest.
   */
  digest(
    chatId: number,
    opts: { kind: 'production' | 'manual'; hours?: number; end?: number; replyTo?: number; threadId?: number | null; to?: number },
  ): Promise<'posted' | 'quiet' | 'failed'> {
    return this.serial(chatId, async () => {
      const { store, config, log } = this.deps;
      const chat = store.getChat(chatId);
      if (!chat) return 'failed';
      const hours = opts.hours ?? 24;
      const end = opts.end ?? this.deps.now();
      const window = { start: end - hours * 3600, end };
      const s = strings(this.uiLang(chat));
      const post = { replyTo: opts.replyTo, threadId: opts.threadId, to: opts.to };

      if (chat.kind === 'watched' && chat.platform === 'discord') {
        const current = await (this.deps.discord?.catchUp(chat) ?? Promise.resolve(false)).catch((err) => {
          log(`chat ${chatId}: Discord catch-up failed: ${describeError(err)}`);
          return false;
        });
        if (!current) log(`chat ${chatId}: not fully caught up; the digest uses what has arrived so far`);
      } else if (chat.kind === 'watched' && this.deps.reader) {
        const reader = this.deps.reader;
        const current = await (reader.catchUp?.(chat) ?? Promise.resolve(true)).catch((err) => {
          log(`chat ${chatId}: reader catch-up failed: ${describeError(err)}`);
          return false;
        });
        if (!current) log(`chat ${chatId}: not fully caught up; the digest uses what has arrived so far`);
        await reader.refresh(chat, window).catch((err) => log(`chat ${chatId}: reader refresh failed: ${describeError(err)}`));
      }
      const count = store.countMessages(chatId, window.start, window.end);
      if (count < config.minDigestMessages) {
        if (opts.kind === 'manual') await this.send(chat, s.notEnough(count, hours), post);
        log(`chat ${chatId}: ${count} messages in the window, no digest`);
        return 'quiet';
      }

      const genome = store.champion(chatId, SEED_PLAYBOOK);
      try {
        const { row, transcript, cost } = await produceDigest(this.deps, chat, window, genome, opts.kind);
        const lang = digestLanguage(chat, transcript);
        const parts = renderDigest(row.digest, {
          chat,
          names: aliasNames(store.users(chatId)),
          window,
          timezone: chat.timezone,
          lang,
          stats: { messages: transcript.messages.length, people: transcript.people },
          version: genome.version,
          validIds: new Set(transcript.byId.keys()),
          streaks: streaks(store, row.digest),
          link: chat.platform === 'discord' ? (id) => store.discordLink(chat.chatId, id) : undefined,
        });
        const ids: number[] = [];
        for (const [i, html] of parts.entries()) {
          const last = i === parts.length - 1;
          ids.push(
            await this.send(chat, html, {
              ...post,
              replyTo: i === 0 ? opts.replyTo : undefined,
              keyboard: last ? voteKeyboard(lang, row.id, { up: 0, down: 0 }) : undefined,
            }),
          );
        }
        store.setPosted(row.id, ids, post.to ?? this.destination(chat));
        const m = row.metrics!;
        log(
          `chat ${chatId}: ${opts.kind} digest #${row.id} posted (v${genome.version}, ${transcript.messages.length} msgs, ` +
            `grounding ${pct(m.grounding)}, coverage ${pct(m.coverage)}, ~$${cost.toFixed(3)})`,
        );
        return 'posted';
      } catch (err) {
        log(`chat ${chatId}: digest failed: ${describeError(err)}`);
        if (opts.kind === 'manual') await this.send(chat, s.failed(escapeHtml(describeError(err).slice(0, 160))), post).catch(() => undefined);
        return 'failed';
      }
    });
  }

  /** The scheduled run for one slot: claim it, post the digest, then one self-improvement round. */
  async scheduled(chatId: number, slot: number, retry = true): Promise<void> {
    const { store, log } = this.deps;
    store.updateChat(chatId, { lastDigestAt: slot });
    const result = await this.digest(chatId, { kind: 'production', end: slot });
    if (result === 'failed' && retry) {
      log(`chat ${chatId}: retrying the digest in 15 minutes`);
      setTimeout(() => void this.scheduled(chatId, slot, false), 15 * 60_000).unref();
      return;
    }
    const chat = store.getChat(chatId);
    if (result === 'posted' && chat && chat.rsiMode !== 'off') await this.evolve(chatId, {});
  }

  /** One self-improvement round. Announces adoptions, proposals and vetoes in the group. */
  evolve(chatId: number, opts: { force?: boolean; replyTo?: number; threadId?: number | null }): Promise<EvolveReport | null> {
    return this.serial(chatId, async () => {
      const { store, log } = this.deps;
      const chat = store.getChat(chatId);
      if (!chat) return null;
      const s = strings(this.uiLang(chat));
      const post = { replyTo: opts.replyTo, threadId: opts.threadId };
      try {
        const report = await evolve(this.deps, chatId, { force: opts.force });
        log(
          `chat ${chatId}: RSI ${report.decision} (v${report.championBefore} → v${report.championAfter}) ${report.reason}` +
            (report.costUsd ? ` ~$${report.costUsd.toFixed(2)}` : ''),
        );
        const best = report.candidates.find((c) => c.outcome !== 'rejected');
        if (report.decision === 'promoted' && best) {
          await this.send(
            chat,
            s.promoted({
              from: report.championBefore,
              to: best.version,
              rationale: escapeHtml(best.rationale),
              days: report.windows.length,
              judge: pct(best.winRate),
              grounding: `${pct(best.championGrounding)}→${pct(best.grounding)}`,
              coverage: `${pct(best.championCoverage)}→${pct(best.coverage)}`,
            }),
            { threadId: post.threadId },
          );
        } else if (report.decision === 'pending' && best) {
          await this.send(
            chat,
            s.pending({ from: report.championBefore, to: best.version, rationale: escapeHtml(best.rationale), days: report.windows.length, judge: pct(best.winRate) }),
            { keyboard: approvalKeyboard(this.uiLang(chat), chatId, best.version), threadId: post.threadId },
          );
        } else if (report.decision === 'vetoed') {
          await this.announceVeto(chat, report.championBefore, report.championAfter);
        } else if (opts.force) {
          await this.send(chat, report.decision === 'held' ? s.held(escapeHtml(report.reason)) : s.evolveSkipped(escapeHtml(report.reason)), post);
        }
        return report;
      } catch (err) {
        log(`chat ${chatId}: RSI round failed: ${describeError(err)}`);
        if (opts.force) await this.send(chat, s.failed(escapeHtml(describeError(err).slice(0, 160))), post).catch(() => undefined);
        return null;
      }
    });
  }

  private async announceVeto(chat: ChatRow, from: number, to: number): Promise<void> {
    const t = this.deps.store.tallyForVersion(chat.chatId, from, 3);
    await this.send(chat, strings(this.uiLang(chat)).vetoed({ from, to, up: t.up, down: t.down }));
  }

  /** After every vote: readers can veto a freshly adopted playbook. */
  async afterVote(chatId: number): Promise<void> {
    const chat = this.deps.store.getChat(chatId);
    if (!chat) return;
    const veto = checkVeto(this.deps.store, chatId);
    if (veto) {
      this.deps.log(`chat ${chatId}: readers vetoed v${veto.from}, back to v${veto.to}`);
      await this.send(chat, strings(this.uiLang(chat)).vetoed(veto));
    }
  }

  /** An admin's answer to a proposed playbook. */
  async decide(chatId: number, version: number, adopt: boolean): Promise<string | null> {
    const { store } = this.deps;
    const chat = store.getChat(chatId);
    const pending = store.pendingGenome(chatId);
    if (!chat || !pending || pending.version !== version) return null;
    const s = strings(this.uiLang(chat));
    const before = store.champion(chatId, SEED_PLAYBOOK).version;
    if (adopt) {
      store.crown(chatId, version);
      return s.approved(before, version);
    }
    store.setGenomeStatus(chatId, version, 'rejected');
    return s.rejected(version);
  }

  /** Admin rollback to the parent (or a given earlier version). The rolled-back version counts as vetoed. */
  rollback(chatId: number, to?: number): string {
    const { store } = this.deps;
    const chat = store.getChat(chatId)!;
    const s = strings(this.uiLang(chat));
    const current = store.champion(chatId, SEED_PLAYBOOK);
    const target = to ?? current.parent;
    if (target === null || target === undefined || target === current.version || !store.genome(chatId, target)) {
      return s.nothingToRollBack;
    }
    store.crown(chatId, target, 'vetoed');
    return s.rolledBack(current.version, target);
  }
}
