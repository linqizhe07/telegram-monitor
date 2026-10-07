// Watches every group for short-term high-frequency terms (src/terms.ts) as messages come in, and
// raises each one once: an activity event the console shows, that alerts lists and that wakes
// Claude when waking is on. No notification of its own: Claude, or the owner reading the console,
// judges what a burst means.

import type { Activity } from './activity.ts';
import { burstsOf, sourcesOf } from './agent-views.ts';
import type { Store } from './store.ts';
import { ALERT_BURST } from './terms.ts';

const KEY = 'term_bursts';

export interface TermWatchDeps {
  store: Store;
  activity: Activity;
  now: () => number;
  /** How often to look (seconds). */
  everyS?: number;
  /** A term is raised again in the same group only after this long (seconds). */
  quietS?: number;
}

export class TermWatch {
  private readonly d: TermWatchDeps;

  constructor(d: TermWatchDeps) {
    this.d = d;
  }

  start(): () => void {
    const timer = setInterval(() => this.check(), (this.d.everyS ?? 120) * 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Looks at every group that is read and had messages in the window; returns what it raised. */
  check(): { chatId: number; term: string; key: string }[] {
    const { store, activity, now } = this.d;
    const t = now();
    const quiet = this.d.quietS ?? 6 * 3600;
    const windowS = ALERT_BURST.windowS ?? 1800;
    let raised: Record<string, number> = {};
    try {
      raised = JSON.parse(store.getKv(KEY) ?? '{}') as Record<string, number>;
    } catch {
      // unreadable: start over
    }
    for (const [k, at] of Object.entries(raised)) if (at < t - quiet) delete raised[k];
    const out: { chatId: number; term: string; key: string }[] = [];
    for (const chat of sourcesOf(store).filter((c) => c.enabled)) {
      if (store.countMessages(chat.chatId, t - windowS, t + 1) === 0) continue;
      for (const b of burstsOf(store, chat, t, ALERT_BURST)) {
        // The same burst, seen again as it grows, may be named by another of its pieces.
        if (b.parts.some((p) => raised[`${chat.chatId}:${p}`])) continue;
        for (const p of b.parts) raised[`${chat.chatId}:${p}`] = t;
        out.push({ chatId: chat.chatId, term: b.term, key: b.key });
        const usual = b.expected < 0.5 ? 'almost never' : `usually about ${b.expected.toFixed(1)}`;
        activity.event('terms', 'term burst', chat.title, `"${b.term}": ${b.count} messages from ${b.people} people in the last ${Math.round(windowS / 60)} min (${usual}) · ${b.ids.map((id) => `#${id}`).join(' ')}`);
      }
    }
    store.setKv(KEY, JSON.stringify(raised));
    return out;
  }
}
