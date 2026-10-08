// One click to find groups worth reading on a topic (Hyperliquid, crypto, RWA, stocks, or the
// owner's own words). Ways in: Telegram's own search, the channels Telegram calls similar to ones
// already read, the discussion groups Telegram links to on-topic channels, what people in the
// watched groups link to (public groups by @username, private ones by invite link), and the groups
// the chats looked at point to themselves (in their posts and descriptions). Groups, channels or
// both: for groups, channels are only a way in.
//
// Then a read-only look at as many as the request budget allows, the most promising first: one
// request for the latest 100 messages (nearly everything is judged from those), and one more for
// the best of them (description, members online, the chat Telegram links it to). A private group
// shows only its cover. Nothing is joined, nothing is posted, and the group is not told; each is
// judged by src/discover-rules.ts.
//
// Every request goes through the same supervised client as the reading (paced, recorded, writes
// refused), and a search sends at most 45, so it takes about a minute. Searches are rationed so the
// account never looks like a crawler: a few an hour, shared by the owner and Claude; invite checks
// share the private-group tracker's own ration. What a look saw is kept in memory for a day (never
// on disk), so the same chat is not looked at twice. Nothing found is watched until the owner (or
// Claude, on the owner's word) says so.

import { Api, type TelegramClient } from 'telegram';
import type { Activity } from './activity.ts';
import {
  assess,
  assessPrivate,
  customTopic,
  describedUsernames,
  impersonation,
  inviteHashes,
  isAbout,
  KINDS,
  linkedUsernames,
  perDayOf,
  portalPost,
  priority,
  scammy,
  TOPICS,
  typicalViews,
  type Assessed,
  type Cover,
  type Found,
  type Kind,
  type Linked,
  type Seen,
  type Topic,
  type TopicId,
} from './discover-rules.ts';
import { InviteBudget, type Lane } from './invite-rules.ts';
import { chatIdOf, explain, toStored, type MtEntity, type MtMessage } from './reader.ts';
import type { Store, StoredMessage } from './store.ts';

export interface DiscoveryRun {
  id: number;
  at: number;
  doneAt: number | null;
  topic: TopicId;
  label: string;
  query: string | null;
  /** Groups, channels or both (searches from before this was asked judged both). */
  kind: Kind;
  /** Who asked: the owner (console) or Claude. */
  by: string;
  /** What it is doing now, for the console while it runs. */
  step: string;
  /** New to the account and of the kind asked for, before any look. */
  found: number;
  looked: number;
  toLook: number;
  /** Requests this search sent Telegram. */
  requests: number;
  /** Looks reused from the last 24 hours instead of asking Telegram again. */
  remembered: number;
  /** When the same search last ran (what NEW is measured against); null: the first such search. */
  previousAt?: number | null;
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
  /** Requests one search may send Telegram, everything included. */
  requests?: number;
  /** A breath between two looks, on top of the account-wide pace. */
  pauseMs?: number;
  /** Invite checks share the private-group tracker's ration (it lives in the store, so a new one reads the same). */
  invites?: InviteBudget;
}

export interface Asker {
  actor: string;
  via: string;
}

const ORDER: Record<Assessed['verdict'], number> = { good: 0, ok: 1, low: 2, closed: 3, scam: 4 };
const DISMISSED = 'discover_dismissed';
const REQUESTS = 45;
/** Username lookups a search may make (Telegram rations them per account, like invite checks). */
const LOOKUPS = 4;
/** Second looks a search may make, and requests kept back for them and for the chats looked-at ones point to. */
const SECOND_LOOKS = 6;
const RESERVE = SECOND_LOOKS + 4;
const DAY = 86_400;

/** A Telegram chat object as search returns it. */
type Chat = MtEntity & { hasLink?: boolean; usernames?: { username: string; active?: boolean }[] };

/** The latest 100 messages and what they say (one request). Kept in memory for a day, never on disk. */
interface Glance {
  at: number;
  readable: boolean;
  sampled: number;
  newestAt: number | null;
  perDay: number | null;
  sample: StoredMessage[];
  botMessages: number;
  hidden: Record<number, string>;
  portal: { posts: number; others: number } | null;
  views: number | null;
  /** Public usernames its messages link to, with how many different posters linked each. */
  links: Map<string, number>;
}

/** Its description, members online, and the chat Telegram links it to (one more request). */
interface Profile {
  at: number;
  about: string;
  online: number | null;
  members: number | null;
  linked: Chat | null;
}

const same = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
const usernameOf = (c: Chat): string | null => c.username ?? c.usernames?.find((u) => u.active)?.username ?? null;

export class Discovery {
  private readonly d: DiscoverDeps;
  private readonly invites: InviteBudget;
  private current: DiscoveryRun | null = null;
  private readonly glances = new Map<number, Glance>();
  private readonly profiles = new Map<number, Profile>();
  /** Invite covers by a stand-in id of the hash (the hash itself is in the cover, in memory only). */
  private readonly covers = new Map<number, { at: number; cover: Cover }>();
  /** Usernames looked up, lower case: Telegram rations username lookups more tightly than anything else here. */
  private readonly names = new Map<string, { at: number; chat: Chat }>();

  constructor(d: DiscoverDeps) {
    this.d = d;
    this.invites = d.invites ?? new InviteBudget(d.store, d.now);
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
    const usedDay = this.d.store.discoveriesSince(t - DAY);
    let nextAt: number | null = null;
    if (usedHour >= this.perHour || usedDay >= this.perDay) {
      const window = usedDay >= this.perDay ? DAY : 3600;
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

  /** Chats the latest searches judged likely scams (a join to one is refused). */
  likelyScams(): Set<number> {
    const out = new Set<number>();
    for (const r of this.d.store.discoveries(20)) for (const a of (r.data as DiscoveryRun).results ?? []) if (a.verdict === 'scam') out.add(a.chatId);
    return out;
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
  start(topicId: string, query: string | null, by: Asker, kind = 'both'): { ok: boolean; message: string; id?: number } {
    if (!this.d.client()) return { ok: false, message: 'The reader account is not signed in.' };
    if (this.current) return { ok: false, message: `A search is already running (${this.current.label}: ${this.current.step}).`, id: this.current.id };
    const q = query?.trim() || null;
    if (!q && !(topicId in TOPICS)) return { ok: false, message: `Unknown topic "${topicId}": hyperliquid, crypto, rwa or stocks, or a query of your own.` };
    if (!(KINDS as readonly string[]).includes(kind)) return { ok: false, message: `Unknown kind "${kind}": groups, channels or both.` };
    const b = this.budget();
    if (b.nextAt !== null) {
      const when = new Date(b.nextAt * 1000).toISOString().slice(11, 16);
      return { ok: false, message: `${b.usedHour >= this.perHour ? `${this.perHour} searches in the last hour` : `${this.perDay} searches today`} already (each one sends Telegram up to ${REQUESTS} requests). The next can start at ${when} UTC.` };
    }
    const topic = q ? customTopic(q) : TOPICS[topicId as keyof typeof TOPICS];
    const t = this.d.now();
    const run: DiscoveryRun = { id: 0, at: t, doneAt: null, topic: topic.id, label: topic.label, query: q, kind: kind as Kind, by: `${by.actor}${by.via}`, step: 'starting', found: 0, looked: 0, toLook: 0, requests: 0, remembered: 0, results: [], notes: [], error: null };
    run.id = this.d.store.saveDiscovery(0, t, topic.id, run);
    this.current = run;
    this.d.activity.event(by.actor, 'find groups', topic.label, `${kind}: searching Telegram, similar channels, discussion groups and the links in your groups${by.via}`);
    void this.run(run, topic, by).catch(() => undefined);
    return { ok: true, message: `Searching for ${topic.label} ${kind === 'both' ? 'groups and channels' : kind}: about a minute.`, id: run.id };
  }

  /** What was seen of a chat (or a username) in the last day, if anything. */
  private recall<K, T extends { at: number }>(map: Map<K, T>, key: K): T | null {
    const x = map.get(key);
    if (x && x.at > this.d.now() - DAY) return x;
    map.delete(key);
    return null;
  }

  private keep<K, T>(map: Map<K, T>, key: K, x: T): T {
    map.delete(key);
    map.set(key, x);
    if (map.size > 500) map.delete(map.keys().next().value as K);
    return x;
  }

  private async run(run: DiscoveryRun, topic: Topic, by: Asker): Promise<void> {
    const { store, now } = this.d;
    const client = this.d.client()!;
    const kind = run.kind;
    const limit = this.d.requests ?? REQUESTS;
    const left = () => limit - run.requests;
    const ask = <T>(step: string, f: () => Promise<T>): Promise<T> => {
      run.requests++;
      run.step = step;
      return f();
    };
    const pause = () => new Promise((r) => setTimeout(r, this.d.pauseMs ?? 600));
    const wanted = (type: 'group' | 'channel') => kind === 'both' || (kind === 'groups') === (type === 'group');
    // Telegram asked the account to wait: nothing more this search.
    const stopOnFlood = (err: unknown) => {
      if (explain(err).retryAfter > 0) throw err;
    };
    const byPriority = (a: Found, b: Found) => priority(b, topic) - priority(a, topic);
    const scams: Assessed[] = [];
    const covers: Assessed[] = [];
    const judged = new Map<number, Assessed>();
    const publish = () => {
      run.results = sorted([...judged.values(), ...scams, ...covers]);
      store.saveDiscovery(run.id, run.at, run.topic, run);
    };
    try {
      const official = await this.officialHandles(topic, run);
      const dismissed = new Set(this.dismissed());
      const found = new Map<number, Found>();
      const entities = new Map<number, Chat>();
      const add = (c: Chat, via: string, extra: { mentions?: number; discusses?: string | null } = {}): Found | null => {
        const username = usernameOf(c);
        if (c.className !== 'Channel' || !username) return null; // only public groups and channels: the rest cannot be found again
        const chatId = chatIdOf(c);
        const known = found.get(chatId);
        if (known) {
          if (!known.via.includes(via)) known.via.push(via);
          known.mentions = Math.max(known.mentions, extra.mentions ?? 0);
          if (extra.discusses) known.discusses = extra.discusses;
          return known;
        }
        entities.set(chatId, c);
        const f: Found = {
          chatId,
          title: c.title ?? username,
          username,
          type: c.broadcast ? 'channel' : 'group',
          members: c.participantsCount ?? null,
          verified: Boolean(c.verified),
          scam: Boolean(c.scam),
          fake: Boolean(c.fake),
          restricted: (c.restrictionReason ?? []).map((r) => `${r.platform}: ${r.reason}`),
          via: [via],
          mentions: extra.mentions ?? 0,
          discusses: extra.discusses ?? null,
        };
        found.set(chatId, f);
        return f;
      };
      const fresh = (f: Found) => store.getChat(f.chatId)?.kind !== 'watched' && !dismissed.has(f.chatId);
      const byName = (username: string) => [...found.values()].find((f) => same(f.username, username)) ?? null;
      // A username looked up in the last day is not asked about again; LOOKUPS bounds the ones that are.
      let lookups = 0;
      const known = (username: string) => this.recall(this.names, username.replace(/^@/, '').toLowerCase())?.chat ?? null;
      const lookUp = async (username: string, step: string): Promise<Chat> => {
        const c = known(username);
        if (c) return c;
        lookups++;
        const chat = (await ask(step, () => client.getEntity(username))) as unknown as Chat;
        return this.keep(this.names, username.replace(/^@/, '').toLowerCase(), { at: now(), chat }).chat;
      };

      // 1. Telegram's own search; for groups, also with the words group titles carry.
      for (const q of kind === 'channels' ? topic.queries : [...topic.queries, ...topic.groupQueries]) {
        const r = (await ask(`searching Telegram for "${q}"`, () => client.invoke(new Api.contacts.Search({ q, limit: 30 })))) as unknown as { chats: Chat[] };
        for (const c of r.chats) add(c, `search "${q}"`);
      }

      // 2. Channels Telegram calls similar: to the topic's channels the account reads, then to the biggest found.
      //    When groups are wanted, they are a way in: step 4 asks for their discussion groups.
      const read = store.listChats(false).filter((c) => c.kind === 'watched' && c.username);
      const seeds = topic.seeds.map((s) => read.find((c) => same(c.username, s))).filter(Boolean).map((c) => ({ ref: `@${c!.username}`, entity: null as Chat | null }));
      const bigChannels = [...found.values()]
        .filter((f) => f.type === 'channel' && !f.scam && !f.fake && !seeds.some((s) => same(f.username, s.ref.slice(1))))
        .sort(byPriority)
        .slice(0, Math.max(0, 2 - seeds.length));
      for (const f of bigChannels) seeds.push({ ref: `@${f.username}`, entity: entities.get(f.chatId) ?? null });
      const seedEntities: Chat[] = [];
      for (const s of seeds.slice(0, kind === 'groups' ? 1 : 3)) {
        try {
          const channel = s.entity ?? (await lookUp(s.ref, `looking up ${s.ref}`));
          seedEntities.push(channel);
          const r = (await ask(`asking Telegram for channels like ${s.ref}`, () => client.invoke(new Api.channels.GetChannelRecommendations({ channel: channel as unknown as Api.TypeEntityLike })))) as unknown as { chats: Chat[] };
          for (const c of r.chats) add(c, `similar to ${s.ref}`);
        } catch (err) {
          stopOnFlood(err);
          run.notes.push(`similar channels to ${s.ref}: ${explain(err).message}`);
        }
      }

      // 3. Public groups people in the watched groups link to.
      for (const [username, people] of this.linkedInYourGroups(topic).slice(0, 3)) {
        const f = byName(username);
        if (f) {
          f.mentions = Math.max(f.mentions, people);
          continue;
        }
        if (!known(username) && lookups >= LOOKUPS) continue;
        try {
          add(await lookUp(username, `looking up @${username}, linked by ${people} people in your groups`), `linked by ${people} people in your groups`, { mentions: people });
        } catch (err) {
          stopOnFlood(err); // otherwise gone or private: nothing to look at
        }
      }

      // 4. The discussion groups Telegram links to on-topic channels (found, or already read): where their readers talk.
      //    What their descriptions name is followed in step 7.
      const leads = new Map<string, { weight: number; from: string }>();
      const lead = (u: string, weight: number, from: string) => {
        const l = leads.get(u.toLowerCase());
        if (!l || l.weight < weight) leads.set(u.toLowerCase(), { weight, from });
      };
      if (kind !== 'channels') {
        const onTopic = [...found.values()].filter((f) => f.type === 'channel' && !f.scam && !f.fake && isAbout(`${f.title} ${f.username}`, topic) && !impersonation(f, topic, official)).sort(byPriority);
        const channels = [...seedEntities, ...onTopic.map((f) => entities.get(f.chatId)!)].filter((c, i, all) => c.hasLink && all.findIndex((x) => chatIdOf(x) === chatIdOf(c)) === i);
        for (const c of channels.slice(0, 3)) {
          const name = usernameOf(c);
          let p = this.recall(this.profiles, chatIdOf(c));
          if (p) run.remembered++;
          else p = this.keep(this.profiles, chatIdOf(c), await ask(`asking Telegram for the discussion group of @${name}`, () => fullLook(client, c, now())));
          if (p.linked && !p.linked.broadcast) add(p.linked, `discussion group of @${name}`, { discusses: name });
          for (const u of describedUsernames(p.about)) lead(u, 2, `@${name}'s description`);
        }
      }

      // Private groups people in the watched groups shared invite links to: only the cover, checked
      // while the search goes on (invite checks are spaced out, and rationed with the tracker's own).
      const lane: Lane = by.actor === 'claude' ? 'mcp' : 'owner';
      let invitesStopped: string | null = null;
      const show = (cover: Cover) => {
        if (wanted(cover.type) && store.getChat(cover.chatId)?.kind !== 'watched' && !dismissed.has(cover.chatId)) covers.push(assessPrivate(cover, topic, official));
      };
      const invites: [string, number][] = [];
      for (const [hash, people] of kind === 'channels' ? [] : this.invitesInYourGroups(topic).filter(([h]) => !dismissed.has(inviteId(h))).slice(0, 3)) {
        const known = this.recall(this.covers, inviteId(hash));
        if (known) {
          run.remembered++;
          show({ ...known.cover, people });
        } else invites.push([hash, people]);
      }
      const tryInvite = async (): Promise<void> => {
        if (invitesStopped || invites.length === 0 || left() <= 0) return;
        const gate = this.invites.take(lane);
        if (!gate.ok) {
          if (!/spaced out/.test(gate.reason)) invitesStopped = gate.reason;
          return;
        }
        const [hash, people] = invites.shift()!;
        try {
          const answer = await ask('checking an invite link shared in your groups', () => client.invoke(new Api.messages.CheckChatInvite({ hash })));
          const cover = coverOf(answer as unknown as InviteAnswer, hash, people);
          if (cover) {
            this.keep(this.covers, inviteId(hash), { at: now(), cover });
            show(cover);
            publish();
          }
        } catch (err) {
          const e = explain(err);
          if (e.retryAfter > 0) {
            this.invites.flood(e.retryAfter);
            throw err;
          }
          // an expired or broken link: nothing to see
        }
      };
      await tryInvite();

      // 5. What is left to judge: new to the account, not hidden, of the kind asked for. What its name
      //    or Telegram's flags give away needs no look, unless Telegram links the group to the project's
      //    own channel as its discussion group.
      const already = [...found.values()].filter((f) => store.getChat(f.chatId)?.kind === 'watched');
      if (already.length) run.notes.push(`${already.length} of what was found you already read: ${already.map((f) => f.title).slice(0, 5).join(', ')}${already.length > 5 ? '…' : ''}.`);
      const queue: Found[] = [];
      let nameChecks = 0;
      for (const f of [...found.values()].filter((x) => fresh(x) && wanted(x.type))) {
        const quick = assess(f, null, topic, official, now());
        if (quick.verdict !== 'scam') {
          queue.push(f);
          continue;
        }
        const e = entities.get(f.chatId)!;
        if (f.type === 'group' && e.hasLink && !f.scam && !f.fake && f.restricted.length === 0 && official.length && nameChecks < 2 && left() > RESERVE) {
          nameChecks++;
          const p = this.recall(this.profiles, f.chatId) ?? this.keep(this.profiles, f.chatId, await ask(`checking which channel ${f.title} belongs to`, () => fullLook(client, e, now())));
          const owner = p.linked?.broadcast ? usernameOf(p.linked) : null;
          if (owner && official.some((h) => same(h, owner))) {
            f.discusses = owner;
            queue.push(f);
            continue;
          }
        }
        scams.push(quick);
      }

      // 6. A first look (the latest 100 messages, one request) at as many as the budget allows, the
      //    most promising first; one seen in the last day is not asked about again.
      queue.sort(byPriority);
      const glanced: Found[] = [];
      const judge = (f: Found) => {
        const g = this.recall(this.glances, f.chatId);
        if (g) judged.set(f.chatId, assess(f, seenOf(g, this.recall(this.profiles, f.chatId), entities.get(f.chatId), f.members, official), topic, official, now()));
      };
      const lookAt = async (f: Found) => {
        if (this.recall(this.glances, f.chatId)) run.remembered++;
        else {
          await tryInvite();
          const g = await ask(`looking at ${f.title} (${run.looked + 1} of ${run.toLook})`, () => firstLook(client, entities.get(f.chatId)!, now()));
          this.keep(this.glances, f.chatId, g);
          await pause();
        }
        run.looked++;
        glanced.push(f);
        judge(f);
        publish();
      };
      const remembered = queue.filter((f) => this.recall(this.glances, f.chatId)).length;
      run.toLook = Math.min(queue.length, remembered + Math.max(0, left() - RESERVE));
      let unlooked = 0;
      for (const f of queue) {
        if (!this.recall(this.glances, f.chatId) && left() <= RESERVE) {
          unlooked++;
          continue;
        }
        await lookAt(f);
      }

      // 7. Where the chats looked at point: groups their posts link to (two or more people in a
      //    group; any post in a channel) and their descriptions name, looked at while the budget lasts.
      for (const f of glanced) {
        const g = this.recall(this.glances, f.chatId);
        for (const [u, people] of g?.links ?? []) if (people >= (f.type === 'channel' ? 1 : 2)) lead(u, people, `@${f.username}`);
      }
      const readNames = new Set(read.map((c) => c.username!.toLowerCase()));
      const next = [...leads.entries()].filter(([u]) => !byName(u) && !readNames.has(u)).sort((a, b) => b[1].weight - a[1].weight);
      for (const [u, l] of next) {
        if (left() <= SECOND_LOOKS + 1) break;
        if (!known(u) && lookups >= LOOKUPS) continue;
        let c: Chat;
        try {
          c = await lookUp(u, `looking up @${u}, linked from ${l.from}`);
        } catch (err) {
          stopOnFlood(err);
          continue;
        }
        const f = add(c, `linked from ${l.from}`);
        if (!f || !fresh(f) || !wanted(f.type) || judged.has(f.chatId) || glanced.includes(f) || scams.some((x) => x.chatId === f.chatId)) continue;
        const quick = assess(f, null, topic, official, now());
        if (quick.verdict === 'scam') {
          scams.push(quick);
          continue;
        }
        run.toLook++;
        await lookAt(f);
      }

      // 8. One more look at the best: description, members online, and the chat Telegram links each to.
      const best = [...judged.values()].filter((a) => a.verdict === 'good' || a.verdict === 'ok').sort((a, b) => b.score - a.score);
      let second = 0;
      for (const a of best) {
        if (this.recall(this.profiles, a.chatId)) continue; // already used by its judgement
        await tryInvite();
        if (second >= SECOND_LOOKS || left() <= 0) break;
        second++;
        const f = found.get(a.chatId)!;
        this.keep(this.profiles, a.chatId, await ask(`reading ${f.title}'s description and who is online`, () => fullLook(client, entities.get(a.chatId)!, now())));
        judge(f);
        publish();
        await pause();
      }

      run.found = [...found.values()].filter((f) => fresh(f) && wanted(f.type)).length + covers.length;
      if (unlooked) run.notes.push(`${unlooked} more were found but not looked at: try narrower words, or check one by name.`);
      const other = [...found.values()].filter((f) => fresh(f) && !wanted(f.type)).length;
      if (other) run.notes.push(`${other} ${kind === 'groups' ? 'channels' : 'groups'} found were left out (${kind} only): choose ${kind === 'groups' ? 'Channels' : 'Groups'} or Both to judge them.`);
      if (invites.length) run.notes.push(`${invites.length} invite link${invites.length === 1 ? '' : 's'} shared in your groups ${invitesStopped ? `not checked: ${invitesStopped}` : 'wait for the next search (invite checks are spaced out)'}.`);
      if (run.remembered) run.notes.push(`${run.remembered} look${run.remembered === 1 ? '' : 's'} came from memory (seen in the last 24 hours), so Telegram was not asked again.`);
      publish();
      const previous = store
        .discoveries(50)
        .map((r) => r.data as DiscoveryRun)
        .find((r) => r.id !== run.id && r.doneAt !== null && !r.error && sameSearch(r, run));
      run.previousAt = previous?.at ?? null;
      if (previous) {
        for (const a of run.results) {
          const p = previous.results.find((x) => x.chatId === a.chatId);
          if (!p) a.isNew = true;
          else if (p.verdict !== a.verdict) a.was = p.verdict;
        }
      }
    } catch (err) {
      const e = explain(err);
      run.error = e.retryAfter > 0 || /FLOOD/.test(e.code) ? `Telegram asked the account to slow down, so the search stopped here: ${e.message}` : e.message;
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
        `${run.kind}: ${run.found} found, ${run.looked} looked at, ${run.requests} requests: ${count('good')} good, ${count('ok')} worth a look, ${count('low')} low, ${count('closed')} closed, ${count('scam')} likely scams${run.error ? ` · stopped: ${run.error}` : ''}${by.via}`,
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
      if (cached && cached.at > this.d.now() - DAY) return [...new Set([...topic.officialHandles, ...cached.handles])];
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

  /** Messages in the watched groups over the last week that carry one of `phrases` and are about the topic (selling and soliciting left out). */
  private shared(topic: Topic, phrases: string[], strip?: RegExp): StoredMessage[] {
    const { store, now } = this.d;
    const t = now();
    const out: StoredMessage[] = [];
    for (const c of store.listChats(true).filter((x) => x.kind === 'watched')) {
      for (const m of store.searchMessages(c.chatId, t - 7 * DAY, t + 1, phrases, 2000)) {
        if (scammy(strip ? m.text.replace(strip, '') : m.text)) continue;
        if (topic.terms.length && !topic.terms.some((w) => m.text.toLowerCase().includes(w))) continue;
        out.push(m);
      }
    }
    return out;
  }

  /** Usernames people in the watched groups linked over the last week, by how many people, most first (scams left out). */
  private linkedInYourGroups(topic: Topic): [string, number][] {
    const own = new Map(this.d.store.listChats(true).map((c) => [c.chatId, (c.username ?? '').toLowerCase()]));
    const people = new Map<string, Set<number>>();
    for (const m of this.shared(topic, ['t.me/', 'telegram.me/'])) {
      for (const u of linkedUsernames(m.text)) {
        if (u.toLowerCase() === own.get(m.chatId)) continue; // a link to the group itself
        const set = people.get(u) ?? new Set<number>();
        set.add(m.userId);
        people.set(u, set);
      }
    }
    return atLeastTwo(people);
  }

  /** Invite links people in the watched groups shared over the last week, by how many people; ones the owner already gave the invite tracker are left out. */
  private invitesInYourGroups(topic: Topic): [string, number][] {
    const tracked = new Set(this.d.store.invites().map((i) => i.hash));
    const people = new Map<string, Set<number>>();
    // An invite link alone reads as promotion (scammy): judge the rest of the message.
    for (const m of this.shared(topic, ['t.me/+', 't.me/joinchat/', 'telegram.me/+', 'telegram.me/joinchat/'], /(t\.me|telegram\.me)\/(\+|joinchat\/)[A-Za-z0-9_-]+/gi)) {
      for (const h of inviteHashes(m.text)) {
        if (tracked.has(h)) continue;
        const set = people.get(h) ?? new Set<number>();
        set.add(m.userId);
        people.set(h, set);
      }
    }
    return atLeastTwo(people);
  }
}

function atLeastTwo(people: Map<string, Set<number>>): [string, number][] {
  return [...people.entries()].map(([k, s]) => [k, s.size] as [string, number]).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
}

/** Whether a run answered the same search (a topic, or the same words) for the same kind; runs from before `kind` judged both. */
export function sameSearch(r: Pick<DiscoveryRun, 'topic' | 'query'> & { kind?: Kind }, k: { topic: string | null; query: string | null; kind: Kind }): boolean {
  const q = (k.query ?? '').trim().toLowerCase();
  return (q ? (r.query ?? '').toLowerCase() === q : r.topic === k.topic && !r.query) && (r.kind ?? 'both') === k.kind;
}

function sorted(results: Assessed[]): Assessed[] {
  return [...results].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.score - a.score || (b.members ?? 0) - (a.members ?? 0));
}

function buttonsOf(m: Api.Message): { text: string; url: string | null }[] {
  const rows = (m.replyMarkup as { rows?: { buttons?: { text?: string; url?: string }[] }[] } | undefined)?.rows ?? [];
  return rows.flatMap((r) => r.buttons ?? []).map((b) => ({ text: b.text ?? '', url: typeof b.url === 'string' ? b.url : null }));
}

/** One request: the latest 100 messages, from which nearly everything is judged. */
async function firstLook(client: TelegramClient, e: Chat, now: number): Promise<Glance> {
  const chatId = chatIdOf(e);
  const g: Glance = { at: now, readable: false, sampled: 0, newestAt: null, perDay: null, sample: [], botMessages: 0, hidden: {}, portal: null, views: null, links: new Map() };
  let got: (Api.Message | Api.MessageService | Api.MessageEmpty)[];
  try {
    got = ((await client.getMessages(e as unknown as Api.Channel, { limit: 100 })) as unknown as (Api.Message | Api.MessageService | Api.MessageEmpty | undefined)[]).filter((m): m is Api.Message | Api.MessageService | Api.MessageEmpty => Boolean(m));
  } catch (err) {
    if (explain(err).retryAfter > 0) throw err; // Telegram asked the account to wait: the search stops
    return g; // only members can read it
  }
  // A deleted message comes back as an empty one, without a date.
  const all = got.filter((m): m is Api.Message | Api.MessageService => m instanceof Api.Message || m instanceof Api.MessageService);
  const plain = all.filter((m): m is Api.Message => m instanceof Api.Message);
  g.readable = true;
  g.sampled = all.length;
  g.newestAt = all.length ? Math.max(...all.map((m) => m.date)) : null;
  g.perDay = perDayOf(got, now);
  const posters = new Map<string, Set<string>>();
  const portal = new Set<number>();
  for (const m of plain) {
    const sender = m.sender as { className?: string; bot?: boolean } | undefined;
    const bot = sender?.className === 'User' && Boolean(sender.bot);
    if (bot) g.botMessages++;
    const buttons = buttonsOf(m);
    const urls = [...(m.entities ?? []).flatMap((x) => (x instanceof Api.MessageEntityTextUrl ? [x.url] : [])), ...buttons.flatMap((b) => (b.url ? [b.url] : []))];
    const labels = buttons.map((b) => b.text).filter(Boolean);
    if (urls.length || labels.length) g.hidden[m.id] = [...labels, ...urls].join(' ');
    if (portalPost(m.message ?? '', labels, urls)) portal.add(m.id);
    const text = `${m.message ?? ''} ${g.hidden[m.id] ?? ''}`;
    if (bot || scammy(text)) continue;
    for (const u of linkedUsernames(text)) {
      const who = posters.get(u) ?? new Set<string>();
      who.add(String(m.senderId ?? chatId));
      posters.set(u, who);
    }
  }
  g.sample = plain.map((m) => toStored(m as unknown as MtMessage, chatId)?.message).filter((m): m is StoredMessage => Boolean(m));
  g.portal = portal.size ? { posts: portal.size, others: g.sample.filter((m) => !portal.has(m.messageId)).length } : null;
  g.views = e.broadcast ? typicalViews(plain, now) : null;
  g.links = new Map([...posters].map(([u, who]) => [u, who.size]));
  return g;
}

/** One more request: the description, members online, and the chat Telegram links it to (the full chat object comes along). */
async function fullLook(client: TelegramClient, e: Chat, now: number): Promise<Profile> {
  const p: Profile = { at: now, about: '', online: null, members: e.participantsCount ?? null, linked: null };
  try {
    const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: e as unknown as Api.Channel }))) as unknown as {
      fullChat: { about?: string; onlineCount?: number; participantsCount?: number; linkedChatId?: unknown };
      chats?: Chat[];
    };
    const f = full.fullChat;
    p.about = (f.about ?? '').slice(0, 400);
    p.online = typeof f.onlineCount === 'number' ? f.onlineCount : null;
    p.members = f.participantsCount ?? p.members;
    const linkedId = f.linkedChatId !== undefined && f.linkedChatId !== null ? String(f.linkedChatId) : null;
    p.linked = linkedId ? ((full.chats ?? []).find((c) => String(c.id) === linkedId) ?? null) : null;
  } catch (err) {
    if (explain(err).retryAfter > 0) throw err;
    // full info can be refused; the first look says enough
  }
  return p;
}

function linkedOf(p: Profile | null, official: string[]): Linked | null {
  const c = p?.linked;
  if (!c) return null;
  const username = usernameOf(c);
  return { username, title: c.title ?? username ?? 'a chat', type: c.broadcast ? 'channel' : 'group', official: Boolean(username && official.some((h) => same(h, username))) };
}

function seenOf(g: Glance, p: Profile | null, e: Chat | undefined, members: number | null, official: string[]): Seen {
  return {
    readable: g.readable,
    members: p?.members ?? members,
    online: p?.online ?? null,
    about: p?.about ?? '',
    perDay: g.perDay,
    newestAt: g.newestAt,
    sample: g.sample,
    botMessages: g.botMessages,
    sampled: g.sampled,
    joinRequest: Boolean(e?.joinRequest),
    hidden: g.hidden,
    portal: g.portal,
    views: g.views,
    linked: linkedOf(p, official),
  };
}

/** messages.checkChatInvite's answer, duck-typed. */
interface InviteAnswer {
  className: string;
  chat?: Chat;
  title?: string;
  about?: string;
  participantsCount?: number;
  broadcast?: boolean;
  verified?: boolean;
  scam?: boolean;
  fake?: boolean;
  requestNeeded?: boolean;
  subscriptionPricing?: unknown;
}

/** What an invite shows someone outside; null when the account is in the chat already. */
function coverOf(inv: InviteAnswer, hash: string, people: number): Cover | null {
  if (inv.className === 'ChatInvitePeek' && inv.chat) {
    const c = inv.chat;
    return { hash, chatId: chatIdOf(c), title: c.title ?? 'a private chat', about: '', members: c.participantsCount ?? null, type: c.broadcast ? 'channel' : 'group', verified: Boolean(c.verified), scam: Boolean(c.scam), fake: Boolean(c.fake), requestNeeded: Boolean(c.joinRequest), paid: false, people };
  }
  if (inv.className === 'ChatInvite') {
    return { hash, chatId: inviteId(hash), title: inv.title ?? 'a private chat', about: inv.about ?? '', members: inv.participantsCount ?? null, type: inv.broadcast ? 'channel' : 'group', verified: Boolean(inv.verified), scam: Boolean(inv.scam), fake: Boolean(inv.fake), requestNeeded: Boolean(inv.requestNeeded), paid: Boolean(inv.subscriptionPricing), people };
  }
  return null;
}

/** A stable stand-in id for a private chat known only by its invite (for Hide and for what is new); real ids never go this low. */
function inviteId(hash: string): number {
  let h = 2166136261;
  for (let i = 0; i < hash.length; i++) h = Math.imul(h ^ hash.charCodeAt(i), 16777619) >>> 0;
  return -(2_000_000_000_000 + h);
}
