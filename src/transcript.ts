import type { StoredMessage, UserRow } from './store.ts';

export interface Window {
  /** Unix seconds, inclusive. */
  start: number;
  /** Unix seconds, exclusive. */
  end: number;
}

/** A conversation people engaged with: a reply thread, or a burst of back-and-forth. */
export interface Unit {
  kind: 'thread' | 'burst';
  ids: number[];
  people: number;
  engagement: number;
  preview: string;
}

export interface Transcript {
  window: Window;
  title: string;
  timezone: string;
  messages: StoredMessage[];
  byId: Map<number, StoredMessage>;
  people: number;
  aliasOf(userId: number): string;
  /** What the model reads: one line per message, ids first, people as aliases. */
  text: string;
  /** The most engaged conversations, used to measure a digest's coverage. */
  hot: Unit[];
  language: 'en' | 'zh';
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(unixSeconds: number, timezone: string): LocalParts {
  const parts = fmt(timezone).formatToParts(new Date(unixSeconds * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDate(unixSeconds: number, timezone: string): string {
  const p = localParts(unixSeconds, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(unixSeconds: number, timezone: string): string {
  const p = localParts(unixSeconds, timezone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatWindow(w: Window, timezone: string): string {
  return `${localDate(w.start, timezone)} ${localTime(w.start, timezone)} → ${localDate(w.end, timezone)} ${localTime(w.end, timezone)}`;
}

/** Unix seconds of the most recent `hour:00` local time at or before `now`. */
export function lastSlot(now: number, timezone: string, hour: number): number {
  const p = localParts(now, timezone);
  // Offset of the zone at `now`, in seconds (local wall time minus UTC).
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 - Math.floor(now / 60) * 60;
  let slot = Date.UTC(p.year, p.month - 1, p.day, hour, 0) / 1000 - offset;
  if (slot > now) slot -= 86_400;
  return slot;
}

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

export function detectLanguage(texts: string[]): 'en' | 'zh' {
  let cjk = 0;
  let latin = 0;
  for (const t of texts) {
    cjk += t.match(CJK)?.length ?? 0;
    latin += t.match(LATIN)?.length ?? 0;
  }
  // One CJK character carries about as much as one Latin word (~5 letters).
  return cjk > 0 && cjk >= latin / 5 ? 'zh' : 'en';
}

/** Characters that carry content: not media placeholders, not one-word acks. */
function substance(text: string): number {
  const t = text.replace(/^\[(sticker|photo|video|gif|voice|video note|document|poll|location|contact)[^\]]*\]\s*/i, '').trim();
  return t.length >= 4 ? t.length : 0;
}

function detectUnits(messages: StoredMessage[]): Unit[] {
  const index = new Map<number, number>();
  messages.forEach((m, i) => index.set(m.messageId, i));
  const parent = messages.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const replies = new Map<number, number>();
  for (const [i, m] of messages.entries()) {
    if (m.replyTo === null) continue;
    const j = index.get(m.replyTo);
    if (j === undefined) continue;
    replies.set(m.replyTo, (replies.get(m.replyTo) ?? 0) + 1);
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  }

  const groups = new Map<number, StoredMessage[]>();
  for (const [i, m] of messages.entries()) {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(m);
    else groups.set(root, [m]);
  }

  const unit = (kind: Unit['kind'], ms: StoredMessage[]): Unit => {
    const first = ms.find((m) => substance(m.text) > 0) ?? ms[0];
    return {
      kind,
      ids: ms.map((m) => m.messageId),
      people: new Set(ms.map((m) => m.userId)).size,
      engagement: ms.reduce((s, m) => s + 1 + m.reactions + (replies.get(m.messageId) ?? 0), 0),
      preview: first.text.replace(/\s+/g, ' ').slice(0, 60),
    };
  };

  const units: Unit[] = [];
  const threaded = new Set<number>();
  for (const ms of groups.values()) {
    if (ms.length < 3) continue;
    const u = unit('thread', ms);
    if (u.people < 2 || ms.reduce((s, m) => s + substance(m.text), 0) < 60) continue;
    units.push(u);
    for (const m of ms) threaded.add(m.messageId);
  }

  // Bursts: back-and-forth without reply links. Split at 20-minute gaps and every 45 minutes.
  let burst: StoredMessage[] = [];
  const flush = () => {
    if (burst.length >= 6) {
      const u = unit('burst', burst);
      if (u.people >= 3 && burst.reduce((s, m) => s + substance(m.text), 0) >= 120) units.push(u);
    }
    burst = [];
  };
  for (const m of messages) {
    if (threaded.has(m.messageId)) continue;
    const prev = burst[burst.length - 1];
    if (prev && (m.date - prev.date > 20 * 60 || m.date - burst[0].date > 45 * 60)) flush();
    burst.push(m);
  }
  flush();

  units.sort((a, b) => b.engagement - a.engagement || a.ids[0] - b.ids[0]);
  return units.slice(0, Math.max(3, Math.min(8, units.length)));
}

function clean(text: string, max: number): string {
  let t = text.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ⏎ ').replace(/[ \t]+/g, ' ').trim();
  // A message cannot close the transcript element it sits in.
  t = t.replace(/<\/?\s*transcript/gi, '‹transcript');
  if (t.length > max) t = `${t.slice(0, max)}…[+${t.length - max} chars]`;
  return t;
}

export function buildTranscript(
  messages: StoredMessage[],
  users: Map<number, UserRow>,
  window: Window,
  opts: { title: string; timezone: string; maxMessageChars: number },
): Transcript {
  const byId = new Map(messages.map((m) => [m.messageId, m]));
  const aliasOf = (userId: number) => users.get(userId)?.alias ?? `U?${userId}`;
  const people = new Set(messages.map((m) => m.userId)).size;

  const lines: string[] = [];
  let day = '';
  for (const m of messages) {
    const d = localDate(m.date, opts.timezone);
    if (d !== day) {
      lines.push(`— ${d} —`);
      day = d;
    }
    const tags = [`#${m.messageId}`, localTime(m.date, opts.timezone), aliasOf(m.userId)];
    if (m.replyTo !== null) tags.push(`↩${m.replyTo}`);
    if (m.reactions > 0) tags.push(`♥${m.reactions}`);
    lines.push(`[${tags.join(' ')}] ${clean(m.text, opts.maxMessageChars)}`);
  }

  const title = opts.title.replace(/"/g, "'");
  const text = [
    `<transcript chat="${title}" window="${formatWindow(window, opts.timezone)} (${opts.timezone})" messages="${messages.length}" people="${people}">`,
    ...lines,
    '</transcript>',
  ].join('\n');

  return {
    window,
    title: opts.title,
    timezone: opts.timezone,
    messages,
    byId,
    people,
    aliasOf,
    text,
    hot: detectUnits(messages),
    language: detectLanguage(messages.map((m) => m.text)),
  };
}

/** Splits messages into consecutive chunks whose formatted size stays under `maxChars`. */
export function chunkMessages(messages: StoredMessage[], maxChars: number, perMessage: (m: StoredMessage) => number): StoredMessage[][] {
  const chunks: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const s = perMessage(m) + 40;
    if (current.length > 0 && size + s > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(m);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
