// The console's "Digests & outgoing messages" panel as folders, one per group: which group each
// kept or sent message is about. Digests saved by Claude say so themselves; digests the service
// posted are traced through the digest record; older rows are matched by the group title in their
// heading. Anything else (bot replies, notices) goes to "Other messages".

import { escapeHtml } from './render.ts';
import type { ChatRow, DigestRow, OutboxRow } from './store.ts';

export interface DigestItem {
  id: number;
  at: number;
  delivered: boolean;
  /** Where it went (a report chat, the owner). */
  to: number;
  /** Its first line, as text: for a digest, the group, the window and who wrote it. */
  heading: string;
  /** The rest of it: Telegram HTML, or (for a digest Claude saved) Markdown escaped as HTML text. */
  body: string;
  format: 'markdown' | 'html';
}

export interface DigestFolder {
  /** The group's chat id as text, or "other". */
  key: string;
  chatId: number | null;
  title: string;
  count: number;
  latestAt: number;
  items: DigestItem[];
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const textOf = (html: string) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m).trim();

/** The first line as a heading (when it is a bold line), and the rest as the body. */
export function splitHeading(html: string): { heading: string; body: string } {
  const nl = html.indexOf('\n');
  const first = nl === -1 ? html : html.slice(0, nl);
  if (/^<b>.*<\/b>$/.test(first.trim())) return { heading: textOf(first), body: nl === -1 ? '' : html.slice(nl + 1).replace(/^\n+/, '') };
  const plain = textOf(html).replace(/\s+/g, ' ');
  return { heading: plain.length > 80 ? `${plain.slice(0, 79)}…` : plain, body: html };
}

export function digestFolders(rows: OutboxRow[], digests: DigestRow[], chats: ChatRow[]): DigestFolder[] {
  // A digest the service posted with no bot is kept as outbox row N and recorded as message -N.
  const postedFor = new Map<number, number>();
  for (const d of digests) for (const id of d.postedIds) if (id < 0) postedFor.set(-id, d.chatId);
  // Longest titles first, so "Binance English" wins over "Binance".
  const byTitle = chats.filter((c) => c.kind === 'watched' || c.kind === 'group').sort((a, b) => b.title.length - a.title.length);
  const titles = new Map(chats.map((c) => [c.chatId, c.title]));
  const folders = new Map<string, DigestFolder>();
  for (const row of rows) {
    const { heading, body } = splitHeading(row.html);
    let source = row.sourceChatId ?? postedFor.get(row.id) ?? null;
    if (source === null) {
      const firstLine = row.html.split('\n', 1)[0];
      source = byTitle.find((c) => c.title && firstLine.includes(escapeHtml(c.title)))?.chatId ?? null;
    }
    const key = source === null ? 'other' : String(source);
    let f = folders.get(key);
    if (!f) {
      f = { key, chatId: source, title: source === null ? 'Other messages' : (titles.get(source) ?? String(source)), count: 0, latestAt: 0, items: [] };
      folders.set(key, f);
    }
    // save_digest keeps Claude's Markdown as escaped text under a "… · written by Claude" heading.
    const format = /· written by Claude$/.test(heading) && !/<[a-z]/i.test(body) ? 'markdown' : 'html';
    f.items.push({ id: row.id, at: row.at, delivered: row.delivered, to: row.chatId, heading, body, format });
    f.count++;
    f.latestAt = Math.max(f.latestAt, row.at);
  }
  for (const f of folders.values()) f.items.sort((a, b) => b.at - a.at || b.id - a.id);
  // Groups by their newest digest; "Other messages" last.
  return [...folders.values()].sort((a, b) => (a.key === 'other' ? 1 : 0) - (b.key === 'other' ? 1 : 0) || b.latestAt - a.latestAt);
}
