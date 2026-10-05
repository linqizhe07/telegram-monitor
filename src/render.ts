import { strings, type UiLang } from './i18n.ts';
import { SECTIONS, type Digest, type DigestItem, type Section } from './schema.ts';
import type { UserRow } from './store.ts';
import { messageLink, type InlineKeyboard } from './telegram.ts';
import { formatWindow, type Window } from './transcript.ts';

/** Telegram counts the visible text; staying under 3900 raw characters keeps every part safe. */
const PART_LIMIT = 3900;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function aliasNames(users: Map<number, UserRow>): Map<string, string> {
  const out = new Map<string, string>();
  for (const u of users.values()) out.set(u.alias, u.displayName || u.username || u.alias);
  return out;
}

const ALIAS = /( ?)(?<![A-Za-z0-9_])(U\d{1,5})(?![0-9])( ?)/g;
const CJK_CHAR = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * Aliases back to display names, as plain text: no @username, so nobody gets pinged.
 * The model spaces a Latin alias off from Chinese ("U5 凌晨"); once it is a Chinese name the space goes.
 */
export function humanize(text: string, names: Map<string, string>): string {
  return text.replace(ALIAS, (match: string, pre: string, alias: string, post: string, offset: number) => {
    const name = names.get(alias);
    if (!name) return match;
    const before = text[offset - 1] ?? '';
    const after = text[offset + match.length] ?? '';
    const lead = pre && !(CJK_CHAR.test(before) && CJK_CHAR.test(name[0])) ? pre : '';
    const trail = post && !(CJK_CHAR.test(after) && CJK_CHAR.test(name[name.length - 1])) ? post : '';
    return `${lead}${name}${trail}`;
  });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface RenderContext {
  chat: { chatId: number; title: string; username: string | null };
  names: Map<string, string>;
  window: Window;
  timezone: string;
  lang: UiLang;
  stats: { messages: number; people: number };
  version: number;
  validIds: Set<number>;
  streaks: Map<string, number>;
}

/** The digest as one or more Telegram HTML messages. */
export function renderDigest(d: Digest, ctx: RenderContext): string[] {
  const s = strings(ctx.lang);
  const text = (x: string) => escapeHtml(humanize(x, ctx.names));
  const link = (refs: number[]) => {
    const first = refs.find((r) => ctx.validIds.has(r));
    const url = first === undefined ? null : messageLink(ctx.chat, first);
    return url ? ` <a href="${url}">↗</a>` : '';
  };

  // Segments are packed into messages; a segment never splits across two.
  const segments: { text: string; gap: '\n' | '\n\n' }[] = [];
  segments.push({
    text: `<b>${escapeHtml(s.digestTitle(ctx.chat.title))}</b>\n<i>${escapeHtml(formatWindow(ctx.window, ctx.timezone))} · ${s.stats(ctx.stats.messages, ctx.stats.people)}</i>`,
    gap: '\n\n',
  });
  if (d.headline.trim()) segments.push({ text: `<b>${s.tldr}</b>  ${text(d.headline)}`, gap: '\n\n' });
  const empty = SECTIONS.every((sec) => d[sec].length === 0);
  if (d.quiet && empty) segments.push({ text: `<i>${s.quiet}</i>`, gap: '\n\n' });

  for (const section of SECTIONS) {
    const items = d[section];
    if (items.length === 0) continue;
    items.forEach((item, i) => {
      const line = clip(renderItem(section, item, i), PART_LIMIT - 200);
      segments.push(i === 0 ? { text: `<b>${s.sections[section]}</b>\n${line}`, gap: '\n\n' } : { text: line, gap: '\n' });
    });
  }
  segments.push({ text: `<i>${s.footer(ctx.version)}</i>`, gap: '\n\n' });

  function renderItem(section: Section, item: DigestItem, i: number): string {
    const streak = ctx.streaks.get(`${section}:${i}`);
    const tail = `${link(item.refs)}${streak ? ` <i>${s.streak(streak)}</i>` : ''}`;
    const bullet = section === 'topics' ? `${i + 1}.` : '•';
    if (section === 'pain_points') {
      const sev = (item as DigestItem & { severity: string }).severity;
      const mark = sev === 'high' ? ' ‼️' : sev === 'medium' ? ' ❗' : '';
      const quote = item.evidence[0] ? `\n    <i>“${text(clip(item.evidence[0], 90))}”</i>` : '';
      return `${bullet} <b>${text(item.title)}</b>${mark} — ${text(item.detail)}${tail}${quote}`;
    }
    if (section === 'opportunities') {
      const o = item as DigestItem & { why_now: string; next_step: string };
      const more = [o.why_now && `<i>${s.whyNow}</i>: ${text(o.why_now)}`, o.next_step && `<i>${s.next}</i>: ${text(o.next_step)}`]
        .filter(Boolean)
        .join(' · ');
      return `${bullet} <b>${text(item.title)}</b> — ${text(item.detail)}${tail}${more ? `\n    ↳ ${more}` : ''}`;
    }
    return `${bullet} <b>${text(item.title)}</b> — ${text(item.detail)}${tail}`;
  }

  const parts: string[] = [];
  let current = '';
  for (const seg of segments) {
    if (current && current.length + seg.gap.length + seg.text.length > PART_LIMIT) {
      parts.push(current);
      current = seg.text;
    } else {
      current = current ? `${current}${seg.gap}${seg.text}` : seg.text;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function voteKeyboard(lang: UiLang, digestId: number, tally: { up: number; down: number }): InlineKeyboard {
  const s = strings(lang);
  return [
    [
      { text: s.useful(tally.up), callback_data: `v:${digestId}:1` },
      { text: s.notUseful(tally.down), callback_data: `v:${digestId}:-1` },
    ],
  ];
}

/** Adopt/reject buttons for a proposed playbook. The chat id travels along: one report chat can serve several groups. */
export function approvalKeyboard(lang: UiLang, chatId: number, version: number): InlineKeyboard {
  const s = strings(lang);
  return [
    [
      { text: s.approve, callback_data: `g:${chatId}:${version}:1` },
      { text: s.reject, callback_data: `g:${chatId}:${version}:0` },
    ],
  ];
}

/** Telegram HTML to plain text, for terminals and reports. */
export function toPlain(html: string): string {
  return html
    .replace(/<a href="[^"]*">↗<\/a>/g, '↗')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
