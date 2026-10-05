import type { Engine } from './engine.ts';
import type { Store } from './store.ts';
import { lastSlot } from './transcript.ts';

/** Fires each group's daily digest at its local hour. Returns a stop function. */
export function startScheduler(
  engine: Engine,
  store: Store,
  opts: { now: () => number; log: (line: string) => void; intervalMs?: number },
): () => void {
  const running = new Set<number>();
  const tick = () => {
    const now = opts.now();
    for (const chat of store.listChats(true)) {
      if (running.has(chat.chatId)) continue;
      const slot = lastSlot(now, chat.timezone, chat.digestHour);
      if ((chat.lastDigestAt ?? 0) >= slot) continue;
      running.add(chat.chatId);
      engine
        .scheduled(chat.chatId, slot)
        .catch((err) => opts.log(`chat ${chat.chatId}: scheduled run failed: ${(err as Error).message}`))
        .finally(() => running.delete(chat.chatId));
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 30_000);
  tick();
  return () => clearInterval(timer);
}
