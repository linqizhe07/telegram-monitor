// One click to find groups worth reading on a topic (Hyperliquid, crypto, RWA, stocks, or the
// owner's own words). Three ways in: Telegram's own search, the channels Telegram calls similar to
// ones already read, and the public groups people in the watched groups link to. Then a read-only
// look at the most promising (src/probe.ts: no join, nothing posted, the group is not told), and
// a judgement of each (src/discover-rules.ts): likely scam, closed, low, worth a look, or good.
//
// Every request goes through the same supervised client as the reading (paced, recorded, writes
// refused), so a search costs about a minute. Searches are rationed so the account never looks
// like a crawler: a few an hour, shared by the owner and Claude. Nothing found is watched until the
// owner (or Claude, on the owner's word) says so.

import { Api, type TelegramClient } from 'telegram';
import type { Activity } from './activity.ts';
import { assess, customTopic, linkedUsernames, priority, scammy, TOPICS, type Assessed, type Found, type Seen, type Topic, type TopicId } from './discover-rules.ts';
import { probeChannel } from './probe.ts';
import { chatIdOf, explain, type MtEntity } from './reader.ts';
import type { Store } from './store.ts';

export interface DiscoveryRun {
  id: number;
  at: number;
  doneAt: number | null;
  topic: TopicId;
  label: string;
  query: string | null;
  /** Who asked: the owner (console) or Claude. */
  by: string;
  /** What it is doing now, for the console while it runs. */
  step: string;
  /** Found by search, similar channels and links, before any look. */
  found: number;
  looked: number;
  toLook: number;
  results: Assessed[];
  notes: string[];
  error: string | null;
}

export interface DiscoverDeps {
  store: Store;
  activity: Activity;
  now: () => number;
  log: (line: string) => void;
  /** The reader account's client (supervised), null when not signed in. */
  client: () => TelegramClient | null;
  fetch?: typeof fetch;
  perHour?: number;
  perDay?: number;
  /** How many of what is found get a look (three requests each). */
  maxLook?: number;
  /** A breath between two looks, on top of the account-wide pace. */
  pauseMs?: number;
}

const ORDER: Record<Assessed['verdict'], number> = { good: 0, ok: 1, low: 2, closed: 3, scam: 4 };
const DISMISSED = 'discover_dismissed';

/** A Telegram chat object as search returns it. */
type Chat = MtEntity & { verified?: boolean; scam?: boolean; fake?: boolean; left?: boolean; megagroup?: boolean };

export class Discovery {
  private readonly d: DiscoverDeps;
  private current: DiscoveryRun | null = null;

  constructor(d: DiscoverDeps) {
    this.d = d;
  }

  private get perHour(): number {
    return this.d.perHour ?? 3;
  }

  private get perDay(): number {
    return this.d.perDay ?? 12;
  }

  budget(): { usedHour: number; usedDay: number; perHour: number; perDay: number; nextAt: number | null } {
    const t = this.d.now();
    const usedHour = this.d.store.discoveriesSince(t - 3600);
    const usedDay = this.d.store.discoveriesSince(t - 86_400);
    let nextAt: number | null = null;
    if (usedHour >= this.perHour || usedDay >= this.perDay) {
      const window = usedDay >= this.perDay ? 86_400 : 3600;
      const runs = this.d.store.discoveries(50).filter((r) => r.at > t - window);
      const limit = usedDay >= this.perDay ? this.perDay : this.perHour;
      nextAt = runs[limit - 1] ? runs[limit - 1].at + window : null; // when the oldest counted one ages out
    }
    return { usedHour, usedDay, perHour: this.perHour, perDay: this.perDay, nextAt };
  }

  /** The search running now, the latest ones, and what is left of the ration. */
  view(): { running: DiscoveryRun | null; latest: DiscoveryRun[]; budget: ReturnType<Discovery['budget']>; available: boolean } {
    const latest = this.d.store
      .discoveries(10)
      .map((r) => r.data as DiscoveryRun)
      .filter((r) => r.doneAt !== null);
    return { running: this.current, latest, budget: this.budget(), available: this.d.client() !== null };
  }

  /** The owner does not want to see this one again. */
  dismiss(chatId: number): { ok: boolean; message: string } {
    const list = this.dismissed();
    if (!list.includes(chatId)) list.push(chatId);
    this.d.store.setKv(DISMISSED, JSON.stringify(list.slice(-500)));
    return { ok: true, message: 'Hidden from future searches.' };
  }

  private dismissed(): number[] {
    try {
      return JSON.parse(this.d.store.getKv(DISMISSED) ?? '[]') as number[];
    } catch {
      return [];
    }
  }

  /** Starts a search (it runs on in the background); the answer says whether it started. */
  start(topicId: string, query: string | null, by: { actor: string; via: string }): { ok: boolean; message: string; id?: number } {
    if (!this.d.client()) return { ok: false, message: 'The reader account is not signed in.' };
    if (this.current) return { ok: false, message: `A search is already running (${this.current.label}: ${this.current.step}).`, id: this.current.id };
    const q = query?.trim() || null;
    if (!q && !(topicId in TOPICS)) return { ok: false, message: `Unknown topic "${topicId}": hyperliquid, crypto, rwa or stocks, or a query of your own.` };
    const b = this.budget();
    if (b.nextAt !== null) {
      const when = new Date(b.nextAt * 1000).toISOString().slice(11, 16);
      return { ok: false, message: `${b.usedHour >= this.perHour ? `${this.perHour} searches in the last hour` : `${this.perDay} searches today`} already (each one sends Telegram about 40 requests). The next can start at ${when} UTC.` };
    }
    const topic = q ? customTopic(q) : TOPICS[topicId as keyof typeof TOPICS];
    const t = this.d.now();
    const run: DiscoveryRun = { id: 0, at: t, doneAt: null, topic: topic.id, label: topic.label, query: q, by: `${by.actor}${by.via}`, step: 'starting', found: 0, looked: 0, toLook: 0, results: [], notes: [], error: null };
    run.id = this.d.store.saveDiscovery(0, t, topic.id, run);
    this.current = run;
    this.d.activity.event(by.actor, 'find groups', topic.label, `searching Telegram, similar channels and the links in your groups${by.via}`);
    void this.run(run, topic, by).catch(() => undefined);
    return { ok: true, message: `Searching for ${topic.label} groups: about a minute.`, id: run.id };
  }

  private async run(run: DiscoveryRun, topic: Topic, by: { actor: string; via: string }): Promise<void> {
    const { store, now } = this.d;
    const client = this.d.client()!;
    const step = (s: string) => {
      run.step = s;
    };
    try {
      const official = await this.officialHandles(topic, run);
      const found = new Map<number, Found>();
      const entities = new Map<number, Chat>();
      const add = (c: Chat, via: string, mentions = 0) => {
        // A channel can carry several usernames (collectible ones): the first active one is its address.
        const username = c.username ?? (c as { usernames?: { username: string; active?: boolean }[] }).usernames?.find((u) => u.active)?.username;
        if (c.className !== 'Channel' || !username) return; // only public groups and channels: the rest cannot be found again
        c.username = username;
        const chatId = chatIdOf(c);
        const f = found.get(chatId);
        if (f) {
          if (!f.via.includes(via)) f.via.push(via);
          f.mentions = Math.max(f.mentions, mentions);
          return;
        }
        entities.set(chatId, c);
        found.set(chatId, {
          chatId,
          title: c.title ?? c.username,
          username: c.username,
          type: c.broadcast ? 'channel' : 'group',
          members: c.participantsCount ?? null,
          verified: Boolean(c.verified),
          scam: Boolean(c.scam),
          fake: Boolean(c.fake),
          restricted: (c.restrictionReason ?? []).map((r) => `${r.platform}: ${r.reason}`),
          via: [via],
          mentions,
        });
      };

      // 1. Telegram's own search.
      for (const q of topic.queries) {
        step(`searching Telegram for "${q}"`);
        const r = (await client.invoke(new Api.contacts.Search({ q, limit: 30 }))) as unknown as { chats: Chat[] };
        for (const c of r.chats) add(c, `search "${q}"`);
      }

      // 2. Channels Telegram calls similar: to the topic's channels the account reads, and the biggest channels found.
      const read = store.listChats(false).filter((c) => c.kind === 'watched' && c.username);
      const seeds = topic.seeds.map((s) => read.find((c) => c.username!.toLowerCase() === s.toLowerCase())).filter(Boolean).map((c) => ({ ref: `@${c!.username}`, entity: null as Chat | null }));
      const bigChannels = [...found.values()].filter((f) => f.type === 'channel' && !f.scam && !f.fake).sort((a, b) => priority(b, topic) - priority(a, topic)).slice(0, Math.max(0, 2 - seeds.length));
      for (const f of bigChannels) seeds.push({ ref: `@${f.username}`, entity: entities.get(f.chatId) ?? null });
      for (const s of seeds.slice(0, 3)) {
        step(`asking Telegram for channels like ${s.ref}`);
        try {
          const channel = s.entity ?? ((await client.getEntity(s.ref)) as unknown as Chat);
          const r = (await client.invoke(new Api.channels.GetChannelRecommendations({ channel: channel as unknown as Api.TypeEntityLike }))) as unknown as { chats: Chat[] };
          for (const c of r.chats) add(c, `similar to ${s.ref}`);
        } catch (err) {
          run.notes.push(`similar channels to ${s.ref}: ${explain(err).message}`);
        }
      }

      // 3. Public groups people in the watched groups link to (no request to find them).
      const linked = this.linkedInYourGroups(topic);
      for (const [username, people] of linked.slice(0, 3)) {
        if ([...found.values()].some((f) => f.username?.toLowerCase() === username.toLowerCase())) {
          for (const f of found.values()) if (f.username?.toLowerCase() === username.toLowerCase()) f.mentions = Math.max(f.mentions, people);
          continue;
        }
        step(`looking up @${username}, linked by ${people} people in your groups`);
        try {
          add((await client.getEntity(username)) as unknown as Chat, `linked by ${people} people in your groups`, people);
        } catch {
          // gone or private: nothing to look at
        }
      }

      // 4. A look at the most promising; what Telegram or its name already gives away needs none.
      const dismissed = new Set(this.dismissed());
      const already = [...found.values()].filter((f) => store.getChat(f.chatId)?.kind === 'watched');
      const fresh = [...found.values()].filter((f) => store.getChat(f.chatId)?.kind !== 'watched' && !dismissed.has(f.chatId));
      run.found = fresh.length;
      if (already.length) run.notes.push(`${already.length} of what was found you already read: ${already.map((f) => f.title).slice(0, 5).join(', ')}${already.length > 5 ? '…' : ''}.`);
      const results: Assessed[] = [];
      const toLook: Found[] = [];
      for (const f of fresh) {
        const quick = assess(f, null, topic, official, now());
        if (quick.verdict === 'scam') results.push(quick);
        else toLook.push(f);
      }
      toLook.sort((a, b) => priority(b, topic) - priority(a, topic));
      const max = this.d.maxLook ?? 12;
      const looking = toLook.slice(0, max);
      run.toLook = looking.length;
      if (toLook.length > max) run.notes.push(`${toLook.length - max} more were found but not looked at (each look costs Telegram three requests): search a narrower query, or Check one by name.`);
      for (const f of looking) {
        step(`looking at ${f.title} (${run.looked + 1} of ${looking.length})`);
        const e = entities.get(f.chatId)!;
        const p = await probeChannel(client, `@${f.username}`, e as unknown as Api.Channel, now(), { sample: true, gapMs: this.d.pauseMs });
        const seen: Seen = {
          readable: Boolean(p.history?.readable),
          members: p.members ?? f.members,
          online: p.online ?? null,
          about: p.about ?? '',
          perDay: p.history?.perDay ?? null,
          newestAt: p.history?.newest ?? null,
          sample: p.sample ?? [],
          botMessages: p.history?.botMessages ?? 0,
          sampled: p.history?.sampled ?? 0,
          joinRequest: Boolean(p.door?.joinRequest),
        };
        results.push(assess({ ...f, scam: f.scam || Boolean(p.flags?.scam), fake: f.fake || Boolean(p.flags?.fake), verified: f.verified || Boolean(p.flags?.verified) }, seen, topic, official, now()));
        run.looked++;
        run.results = sorted(results);
        store.saveDiscovery(run.id, run.at, run.topic, run);
        await new Promise((r) => setTimeout(r, this.d.pauseMs ?? 1000));
      }
      run.results = sorted(results);
    } catch (err) {
      const e = explain(err);
      run.error = /FLOOD|wait/i.test(e.message) ? `Telegram asked the account to slow down, so the search stopped here: ${e.message}` : e.message;
    } finally {
      run.doneAt = now();
      run.step = 'done';
      store.saveDiscovery(run.id, run.at, run.topic, run);
      this.current = null;
      const count = (v: Assessed['verdict']) => run.results.filter((r) => r.verdict === v).length;
      this.d.activity.event(
        by.actor,
        'groups found',
        run.label,
        `${run.found} found, ${run.looked} looked at: ${count('good')} good, ${count('ok')} worth a look, ${count('low')} low, ${count('closed')} closed, ${count('scam')} likely scams${run.error ? ` · stopped: ${run.error}` : ''}${by.via}`,
        !run.error,
      );
    }
  }

  /** The topic's official Telegram handles: those its own sites link to (read at most once a day), and the ones known. */
  private async officialHandles(topic: Topic, run: DiscoveryRun): Promise<string[]> {
    if (topic.officialSites.length === 0) return topic.officialHandles;
    const key = `official_handles:${topic.id}`;
    try {
      const cached = JSON.parse(this.d.store.getKv(key) ?? 'null') as { at: number; handles: string[] } | null;
      if (cached && cached.at > this.d.now() - 86_400) return [...new Set([...topic.officialHandles, ...cached.handles])];
    } catch {
      // read again
    }
    run.step = `reading ${topic.officialSites.join(', ')} for its official Telegram links`;
    const handles: string[] = [];
    for (const site of topic.officialSites) {
      try {
        const res = await (this.d.fetch ?? fetch)(site, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) telegram-monitor' } });
        const html = await res.text();
        for (const u of linkedUsernames(html)) handles.push(u);
      } catch {
        run.notes.push(`${site} did not answer: only the official handles known on 2026-10-07 were used.`);
      }
    }
    if (handles.length) this.d.store.setKv(key, JSON.stringify({ at: this.d.now(), handles }));
    return [...new Set([...topic.officialHandles, ...handles])];
  }

  /** Usernames people in the watched groups linked over the last week, by how many people, most first (scams left out). */
  private linkedInYourGroups(topic: Topic): [string, number][] {
    const { store, now } = this.d;
    const t = now();
    const people = new Map<string, Set<number>>();
    const terms = topic.terms;
    for (const c of store.listChats(true).filter((x) => x.kind === 'watched')) {
      for (const m of store.searchMessages(c.chatId, t - 7 * 86_400, t + 1, ['t.me/', 'telegram.me/'], 2000)) {
        if (scammy(m.text)) continue;
        if (terms.length && !terms.some((w) => m.text.toLowerCase().includes(w))) continue;
        for (const u of linkedUsernames(m.text)) {
          if (u.toLowerCase() === (c.username ?? '').toLowerCase()) continue; // a link to the group itself
          const set = people.get(u) ?? new Set<number>();
          set.add(m.userId);
          people.set(u, set);
        }
      }
    }
    return [...people.entries()].map(([u, s]) => [u, s.size] as [string, number]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  }
}

function sorted(results: Assessed[]): Assessed[] {
  return [...results].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.score - a.score || (b.members ?? 0) - (a.members ?? 0));
}
