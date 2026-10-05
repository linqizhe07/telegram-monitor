// Loads a recorded (or synthetic) group chat into a store, and scores digests against the
// fixture's hand-labelled ground truth. Used by the replay script and the tests; the live bot
// never has ground truth.

import { readFileSync } from 'node:fs';
import type { ChatDefaults, Store } from './store.ts';
import { allItems, SECTIONS, type Digest, type Section } from './schema.ts';
import type { Window } from './transcript.ts';

export interface FixtureMessage {
  message_id: number;
  date: string;
  from: number;
  text: string;
  reply_to: number | null;
  reactions: number;
  media: null | { type: string; emoji?: string; duration?: number; file_name?: string };
  forward_from: string | null;
}

export interface FixtureItem {
  title: string;
  message_ids: number[];
}

export type FixtureDay = Record<Section, FixtureItem[]> & { noise_message_ids: number[] };

export interface Fixture {
  meta: {
    synthetic: boolean;
    description: string;
    chat: { id: number; title: string; type: string; username: string | null };
    timezone: string;
    days: { label: string; start: string; end: string }[];
  };
  users: { id: number; first_name: string; last_name: string | null; username: string | null; is_bot: boolean }[];
  messages: FixtureMessage[];
  ground_truth: Record<string, FixtureDay>;
}

export function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const toUnix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const duration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The same one-line form the bot stores for a live message. */
export function fixtureText(m: FixtureMessage): string {
  const parts: string[] = [];
  if (m.forward_from) parts.push(`[forwarded from ${m.forward_from}]`);
  const media = m.media;
  if (media) {
    if (media.type === 'sticker') parts.push(media.emoji ? `[sticker ${media.emoji}]` : '[sticker]');
    else if (media.type === 'voice') parts.push(`[voice ${duration(media.duration ?? 0)}]`);
    else if (media.type === 'document') parts.push(media.file_name ? `[document: ${media.file_name}]` : '[document]');
    else parts.push(`[${media.type}]`);
  }
  if (m.text.trim()) parts.push(m.text.trim());
  return parts.join(' ');
}

/** Loads the fixture's chat, people and messages; returns its chat id and day windows. */
export function seedFixture(store: Store, f: Fixture, defaults: ChatDefaults): { chatId: number; days: (Window & { label: string })[] } {
  const chatId = f.meta.chat.id;
  store.upsertChat({ chatId, title: f.meta.chat.title, username: f.meta.chat.username, type: f.meta.chat.type }, { ...defaults, timezone: f.meta.timezone });
  const users = new Map(f.users.map((u) => [u.id, u]));
  store.transaction(() => {
    for (const m of f.messages) {
      const u = users.get(m.from);
      if (!u || u.is_bot) continue; // the bot ignores other bots, as it does live
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      store.upsertUser(chatId, u.id, name, u.username);
      store.saveMessage({
        chatId,
        messageId: m.message_id,
        threadId: null,
        userId: u.id,
        date: toUnix(m.date),
        text: fixtureText(m),
        replyTo: m.reply_to,
        reactions: m.reactions,
        edited: false,
      });
    }
  });
  return { chatId, days: f.meta.days.map((d) => ({ label: d.label, start: toUnix(d.start), end: toUnix(d.end) })) };
}

export interface GroundTruthScore {
  rows: { section: Section; title: string; inSection: boolean; anywhere: boolean }[];
  /** Planted items cited in their own section / anywhere. */
  inSection: number;
  anywhere: number;
  total: number;
  /** Cited message ids that are labelled noise. */
  noiseCited: number;
  cited: number;
}

/** How many planted items a digest found: an item counts when it cites one of the item's messages. */
export function scoreGroundTruth(d: Digest, day: FixtureDay): GroundTruthScore {
  const items = allItems(d);
  const rows: GroundTruthScore['rows'] = [];
  for (const section of SECTIONS) {
    for (const gt of day[section] ?? []) {
      const hit = (refs: number[]) => refs.some((r) => gt.message_ids.includes(r));
      rows.push({
        section,
        title: gt.title,
        inSection: d[section].some((x) => hit(x.refs)),
        anywhere: items.some(({ item }) => hit(item.refs)),
      });
    }
  }
  const cited = new Set(items.flatMap(({ item }) => item.refs));
  const noise = new Set(day.noise_message_ids ?? []);
  return {
    rows,
    inSection: rows.filter((r) => r.inSection).length,
    anywhere: rows.filter((r) => r.anywhere).length,
    total: rows.length,
    noiseCited: [...cited].filter((r) => noise.has(r)).length,
    cited: cited.size,
  };
}
