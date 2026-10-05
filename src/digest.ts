import type { Config } from './config.ts';
import { LlmError, type Llm, type LlmRequest, type LlmUsage } from './llm.ts';
import { digestTask, historyItems, mergeTask, parseItemCode, type HistoryItem } from './prompts.ts';
import { measure } from './rsi/fitness.ts';
import { allItems, DigestSchema, type Digest } from './schema.ts';
import type { ChatRow, DigestKind, DigestRow, GenomeRow, Store } from './store.ts';
import { buildTranscript, chunkMessages, localDate, type Transcript, type Window } from './transcript.ts';

export interface DigestDeps {
  store: Store;
  llm: Llm;
  config: Config;
  log: (line: string) => void;
}

export function loadTranscript(deps: DigestDeps, chat: ChatRow, window: Window): Transcript {
  const messages = deps.store.messages(chat.chatId, window.start, window.end);
  return buildTranscript(messages, deps.store.users(chat.chatId), window, {
    title: chat.title,
    timezone: chat.timezone,
    maxMessageChars: deps.config.maxMessageChars,
  });
}

export function digestLanguage(chat: ChatRow, t: Transcript): 'en' | 'zh' {
  return chat.language === 'auto' ? t.language : chat.language;
}

/** Items of the production digests posted in the week before this window. */
export function historyFor(store: Store, chat: ChatRow, window: Window): HistoryItem[] {
  const digests = store
    .postedDigestsSince(chat.chatId, window.end - 8 * 86_400)
    .filter((d) => d.windowEnd <= window.start + 3600 && !(d.windowStart === window.start && d.windowEnd === window.end));
  return historyItems(digests.map((d) => ({ id: d.id, date: localDate(d.windowEnd - 1, chat.timezone), digest: d.digest })));
}

export function recordUsage(store: Store, chatId: number | null, usages: LlmUsage[]): number {
  let cost = 0;
  for (const u of usages) {
    store.addUsage({ chatId, ...u });
    cost += u.costUsd ?? 0;
  }
  return cost;
}

async function call(llm: Llm, req: LlmRequest<Digest>): Promise<{ data: Digest; usage: LlmUsage[] }> {
  try {
    const { data, usage } = await llm.json(req);
    return { data, usage: [usage] };
  } catch (err) {
    // A digest that ran out of room gets one retry with twice the budget.
    if (err instanceof LlmError && err.kind === 'truncated') {
      const first = err.usage ? [err.usage] : [];
      const { data, usage } = await llm.json({ ...req, maxTokens: (req.maxTokens ?? 32_000) * 2 });
      return { data, usage: [...first, usage] };
    }
    throw err;
  }
}

/** Writes a digest of the transcript with the given playbook; splits and merges windows too long for one call. */
export async function writeDigest(
  deps: DigestDeps,
  t: Transcript,
  p: { title: string; language: 'en' | 'zh'; playbook: string; version: number; history: HistoryItem[] },
): Promise<{ digest: Digest; usages: LlmUsage[] }> {
  const { llm, config } = deps;
  if (t.text.length <= config.maxTranscriptChars) {
    const { data, usage } = await call(llm, {
      role: 'digest',
      context: t.text,
      instructions: digestTask(p),
      schema: DigestSchema,
      effort: config.digestEffort,
    });
    return { digest: data, usages: usage };
  }

  const users = new Map<number, { userId: number; alias: string; displayName: string; username: string | null }>();
  for (const m of t.messages) users.set(m.userId, { userId: m.userId, alias: t.aliasOf(m.userId), displayName: '', username: null });
  const chunks = chunkMessages(t.messages, Math.floor(config.maxTranscriptChars * 0.9), (m) => Math.min(m.text.length, config.maxMessageChars));
  deps.log(`window too long (${t.text.length} chars): digesting ${chunks.length} parts, then merging`);
  const usages: LlmUsage[] = [];
  const parts: Digest[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const sub = buildTranscript(chunk, users, { start: chunk[0].date, end: chunk[chunk.length - 1].date + 1 }, {
      title: t.title,
      timezone: t.timezone,
      maxMessageChars: config.maxMessageChars,
    });
    const { data, usage } = await call(llm, {
      role: 'digest',
      context: sub.text,
      instructions: digestTask({ ...p, part: { index: i + 1, total: chunks.length } }),
      schema: DigestSchema,
      effort: config.digestEffort,
    });
    usages.push(...usage);
    parts.push(data);
  }
  const { data, usage } = await call(llm, {
    role: 'merge',
    context: parts.map((d, i) => `<part index="${i + 1}">\n${JSON.stringify(d)}\n</part>`).join('\n'),
    instructions: mergeTask({ ...p, parts: parts.length }),
    schema: DigestSchema,
    effort: config.digestEffort,
  });
  usages.push(...usage);
  return { digest: data, usages };
}

/** Writes, measures and stores one digest of `window` by `genome`. */
export async function produceDigest(
  deps: DigestDeps,
  chat: ChatRow,
  window: Window,
  genome: GenomeRow,
  kind: DigestKind,
  transcript?: Transcript,
): Promise<{ row: DigestRow; transcript: Transcript; cost: number }> {
  const t = transcript ?? loadTranscript(deps, chat, window);
  const { digest, usages } = await writeDigest(deps, t, {
    title: chat.title,
    language: digestLanguage(chat, t),
    playbook: genome.playbook,
    version: genome.version,
    history: historyFor(deps.store, chat, window),
  });
  const cost = recordUsage(deps.store, chat.chatId, usages);
  const metrics = measure(digest, t);
  const id = deps.store.saveDigest({
    chatId: chat.chatId,
    kind,
    windowStart: window.start,
    windowEnd: window.end,
    genomeVersion: genome.version,
    digest,
    metrics,
  });
  return { row: deps.store.digest(id)!, transcript: t, cost };
}

/** How many consecutive digests each item has been running for ("continues" chains), when 2 or more. */
export function streaks(store: Store, digest: Digest): Map<string, number> {
  const out = new Map<string, number>();
  const depth = (code: string, guard: number): number => {
    const ref = parseItemCode(code);
    if (!ref || guard > 30) return 0;
    const row = store.digest(ref.digestId);
    const item = row?.digest[ref.section]?.[ref.index];
    if (!item) return 0;
    return 1 + (item.continues ? depth(item.continues, guard + 1) : 0);
  };
  for (const { section, item, index } of allItems(digest)) {
    if (!item.continues) continue;
    const n = 1 + depth(item.continues, 0);
    if (n >= 2) out.set(`${section}:${index}`, n);
  }
  return out;
}
