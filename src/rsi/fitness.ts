// Checks a digest against its transcript with code, not with a model. These numbers are the
// part of the RSI fitness the system cannot talk itself into: the improver never sees this code
// and cannot change it.

import { allItems, type Digest } from '../schema.ts';
import type { Transcript } from '../transcript.ts';

export interface Metrics {
  items: number;
  /** Share of items whose every ref exists in the window and whose every quote is found in the cited messages. */
  grounding: number;
  invalidRefs: number;
  unverifiedQuotes: number;
  /** Share of the most-engaged conversations the digest cites at least once (null when none were detected). */
  coverage: number | null;
  hot: number;
  missed: { ids: number[]; preview: string }[];
  /** Items citing exactly the same messages as an earlier item. */
  duplicates: number;
}

/** Lowercase, width-fold and strip punctuation/space so quotes survive trivial reformatting. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** A quote shortened with "…" passes when every fragment appears, in order, in the (normalized) source. */
export function quoteFound(quote: string, normalizedSource: string): boolean {
  const fragments = quote
    .split(/…|\.\.\./)
    .map(normalize)
    .filter((f) => f.length > 0);
  let from = 0;
  for (const f of fragments) {
    const at = normalizedSource.indexOf(f, from);
    if (at < 0) return false;
    from = at + f.length;
  }
  return true;
}

export function measure(d: Digest, t: Transcript): Metrics {
  const items = allItems(d);
  let grounded = 0;
  let invalidRefs = 0;
  let unverifiedQuotes = 0;
  const cited = new Set<number>();
  const seen = new Set<string>();
  let duplicates = 0;

  for (const { item } of items) {
    const valid = item.refs.filter((r) => t.byId.has(r));
    invalidRefs += item.refs.length - valid.length;
    valid.forEach((r) => cited.add(r));

    const source = normalize(valid.map((r) => t.byId.get(r)!.text).join(' '));
    const badQuotes = item.evidence.filter((q) => !quoteFound(q, source)).length;
    unverifiedQuotes += badQuotes;

    if (item.refs.length > 0 && valid.length === item.refs.length && badQuotes === 0) grounded++;

    const key = [...valid].sort((a, b) => a - b).join(',');
    if (key && seen.has(key)) duplicates++;
    seen.add(key);
  }

  const missed = t.hot.filter((u) => !u.ids.some((id) => cited.has(id)));
  return {
    items: items.length,
    grounding: items.length === 0 ? 1 : grounded / items.length,
    invalidRefs,
    unverifiedQuotes,
    coverage: t.hot.length === 0 ? null : (t.hot.length - missed.length) / t.hot.length,
    hot: t.hot.length,
    missed: missed.map((u) => ({ ids: u.ids.slice(0, 6), preview: u.preview })),
    duplicates,
  };
}

/** Removes citations a reader could not follow. The stored digest keeps them, so metrics stay honest. */
export function withoutInvalidRefs(d: Digest, valid: Set<number>): Digest {
  const strip = <T extends { refs: number[] }>(xs: T[]): T[] => xs.map((x) => ({ ...x, refs: x.refs.filter((r) => valid.has(r)) }));
  return {
    ...d,
    topics: strip(d.topics),
    pain_points: strip(d.pain_points),
    ideas: strip(d.ideas),
    opportunities: strip(d.opportunities),
    open_questions: strip(d.open_questions),
  };
}

export function formatMetrics(m: Metrics): string {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const lines = [
    `grounding ${pct(m.grounding)} (${m.items} items, ${m.invalidRefs} citations to messages that do not exist, ${m.unverifiedQuotes} quotes not found in the cited messages)`,
    `coverage of the most-engaged conversations ${pct(m.coverage)} (${m.hot - m.missed.length}/${m.hot})`,
  ];
  if (m.duplicates) lines.push(`${m.duplicates} items duplicate another item's citations`);
  for (const u of m.missed) lines.push(`missed conversation #${u.ids[0]}…: "${u.preview}"`);
  return lines.join('\n');
}
