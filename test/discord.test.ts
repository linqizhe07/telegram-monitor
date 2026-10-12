import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiscordError, snowflakeAt, type DiscordGateway, type DiscordMessage, type DiscordRest, type GatewayState } from '../src/discord-client.ts';
import { DiscordReader, canSee } from '../src/discord.ts';
import { DISCORD_BASE, isDiscordChat, type StoredMessage } from '../src/store.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
const GUILD = '1000000000000000001';
const BOT = '2000000000000000002';
const ROLE = '3000000000000000003';
const TEXT = '1100000000000000011';
const NEWS = '1100000000000000012';
const SECRET = '1100000000000000013';
const VOICE = '1100000000000000014';
const VIEW = String(1 << 10);

test('the store: a Discord channel is a watched source with its own chat id, never one Telegram could give or reuse', () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const { chat, created } = store.addDiscordChannel({ channelId: TEXT, guildId: GUILD, guildName: 'Ours', name: 'general', type: 0 }, 42, true, DEFAULTS);
  assert.ok(created);
  assert.ok(isDiscordChat(chat.chatId) && chat.chatId === DISCORD_BASE + 1 && Number.isSafeInteger(chat.chatId));
  assert.equal(chat.platform, 'discord');
  assert.equal(chat.kind, 'watched');
  assert.equal(chat.title, 'Ours · #general');
  assert.equal(chat.reportChatId, 42, 'digests go where the Telegram ones go');
  // Nothing a Telegram code path could take for a Telegram chat: no @username, address or Telegram type.
  assert.equal(chat.username, null);
  assert.equal(chat.readerPeer, null);
  assert.equal(chat.type, 'discord');
  assert.equal(chat.readerRef, `discord:${TEXT}`);
  assert.equal(store.getChat(-1001234567890), null);
  assert.equal(memoryStore(clock).getChat(DISCORD_BASE + 1), null);

  // Renamed: the same source, a new title.
  const again = store.addDiscordChannel({ channelId: TEXT, guildId: GUILD, guildName: 'Ours v2', name: 'chat', type: 0 }, 42, false, DEFAULTS);
  assert.equal(again.created, false);
  assert.equal(again.chat.chatId, chat.chatId);
  assert.equal(again.chat.title, 'Ours v2 · #chat');
  assert.equal(again.chat.enabled, true, 'a rename does not switch it');

  // Message ids: the channel's own numbers, never reused (snowflakes stay text).
  assert.deepEqual(store.discordMessageId(chat.chatId, '1234567890123456789'), { id: 1, created: true });
  assert.deepEqual(store.discordMessageId(chat.chatId, '1234567890123456790'), { id: 2, created: true });
  assert.deepEqual(store.discordMessageId(chat.chatId, '1234567890123456789'), { id: 1, created: false });
  store.saveMessage({ chatId: chat.chatId, messageId: 1, threadId: null, userId: store.discordUserId('77'), date: T0 - 10 * 86_400, text: 'old', replyTo: null, reactions: 0, edited: false });
  store.saveMessage({ chatId: chat.chatId, messageId: 2, threadId: null, userId: store.discordUserId('77'), date: T0, text: 'new', replyTo: null, reactions: 0, edited: false });
  assert.equal(store.discordLink(chat.chatId, 2), `https://discord.com/channels/${GUILD}/${TEXT}/1234567890123456790`);
  // Retention takes the old one and its Discord id; the next message still gets a new number.
  store.purgeBefore(T0 - 7 * 86_400);
  assert.equal(store.knownDiscordMessage(chat.chatId, '1234567890123456789'), null);
  assert.equal(store.discordMessageId(chat.chatId, '1234567890123456800').id, 3);
  // Users: a stable id each, past anything Telegram gives.
  assert.equal(store.discordUserId('77'), store.discordUserId('77'));
  assert.ok(store.discordUserId('78') > DISCORD_BASE);

  // Gone (the bot was taken out): the source, its messages and Discord ids go; the next channel gets a new chat id.
  assert.ok(store.removeSource(chat.chatId));
  assert.equal(store.discordChannel({ chatId: chat.chatId }), null);
  assert.equal(store.knownDiscordMessage(chat.chatId, '1234567890123456790'), null);
  const next = store.addDiscordChannel({ channelId: NEWS, guildId: GUILD, guildName: 'Ours', name: 'news', type: 5 }, 42, true, DEFAULTS);
  assert.equal(next.chat.chatId, DISCORD_BASE + 2, 'chat ids are never reused (old digests keep theirs)');
  assert.equal(store.discordChannel({ chatId: next.chat.chatId })!.feed, true, 'an announcement channel is a feed');
});

test("what the bot can see, by Discord's rules: roles, @everyone's and the channel's overwrites, the bot's own", () => {
  const guild = {
    id: GUILD,
    name: 'Ours',
    owner_id: '999',
    roles: [
      { id: GUILD, permissions: VIEW },
      { id: ROLE, permissions: '0' },
    ],
    members: [{ user: { id: BOT }, roles: [ROLE] }],
  };
  assert.equal(canSee(guild, {}, BOT), true, '@everyone can view');
  assert.equal(canSee(guild, { permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] }, BOT), false, 'hidden from @everyone');
  assert.equal(canSee(guild, { permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }, { id: ROLE, type: 0, allow: VIEW, deny: '0' }] }, BOT), true, "the bot's role may");
  assert.equal(canSee(guild, { permission_overwrites: [{ id: ROLE, type: 0, allow: VIEW, deny: '0' }, { id: BOT, type: 1, allow: '0', deny: VIEW }] }, BOT), false, 'the bot itself may not');
  assert.equal(canSee({ ...guild, roles: [{ id: GUILD, permissions: '0' }, { id: ROLE, permissions: String(1 << 3) }] }, { permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] }, BOT), true, 'an administrator sees everything');
  assert.equal(canSee({ ...guild, members: [] }, {}, BOT), null, 'not enough said: a read finds out');
});

/** A Discord the test plays: the REST answers and the gateway's events. */
function setup(opts: { autoWatch?: boolean; reportTo?: number | null } = {}) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const asked: { channel: string; after?: string }[] = [];
  const history = new Map<string, DiscordMessage[]>();
  /** Channels Discord answers 403 for (the bot cannot see them); a channel's messages that fail once. */
  const hidden = new Set<string>();
  const failOnce = new Set<string>();
  const rest = {
    me: async () => ({ id: BOT, username: 'pulse-bot', bot: true }),
    messages: async (channel: string, page: { after?: string }) => {
      asked.push({ channel, after: page.after });
      if (failOnce.delete(channel)) throw new Error('fetch failed');
      if (hidden.has(channel)) throw new DiscordError(403, 50001, 'Missing Access');
      const all = (history.get(channel) ?? []).filter((m) => !page.after || BigInt(m.id) > BigInt(page.after));
      return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).slice(0, 100).reverse(); // newest first, as Discord answers
    },
    channel: async (id: string) => {
      if (hidden.has(id)) throw new DiscordError(403, 50001, 'Missing Access');
      return { id, type: 0 };
    },
  } as unknown as DiscordRest;
  let dispatch: (event: string, data: unknown) => void = () => undefined;
  let state: (s: GatewayState, e: string | null) => void = () => undefined;
  let started = 0;
  const gw = { state: 'online' as GatewayState, error: null, fatalCode: null as number | null, start: () => void started++, stop: () => undefined } as unknown as DiscordGateway & { fatalCode: number | null };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const events: { method: string; target: string; detail: string }[] = [];
  const activity = {
    event: (_a: string, method: string, target = '', detail = '') => events.push({ method, target, detail }),
    record: () => undefined,
  } as never;
  const stored: StoredMessage[] = [];
  const reader = new DiscordReader({
    token: 'T',
    store,
    activity,
    now: clock.now,
    log: () => undefined,
    reportTo: opts.reportTo === undefined ? 42 : opts.reportTo,
    defaults: DEFAULTS,
    autoWatch: () => opts.autoWatch ?? true,
    maxMessageChars: 2000,
    retentionDays: 7,
    onStored: (_chatId, msgs) => stored.push(...msgs),
    rest,
    gateway: (onDispatch, onState) => {
      dispatch = onDispatch;
      state = onState;
      return gw;
    },
    // Timers the test fires: retries, the hourly look, the activity log's batching.
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
  });
  const guild = (channels: unknown[]) => ({
    id: GUILD,
    name: 'Ours',
    owner_id: '999',
    roles: [{ id: GUILD, permissions: String((1 << 10) | (1 << 16)) }], // @everyone: view channels, read history
    members: [{ user: { id: BOT }, roles: [] }],
    channels,
  });
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const fire = (ms: number) => {
    const t = timers.find((x) => x.live && x.ms === ms);
    assert.ok(t, `a timer of ${ms} ms is waiting`);
    t.live = false;
    t.fn();
  };
  return { clock, store, rest, reader, history, asked, events, stored, guild, settle, hidden, failOnce, gw, timers, fire, dispatch: (e: string, d: unknown) => dispatch(e, d), state: (s: GatewayState, e: string | null = null) => state(s, e), started: () => started };
}

let seq = 0;
/** A message posted `ago` seconds before T0. */
const post = (channel: string, ago: number, content: string, over: Partial<DiscordMessage> = {}): DiscordMessage => {
  const id = (BigInt(snowflakeAt(T0 - ago)) + BigInt(++seq)).toString();
  return { id, channel_id: channel, author: { id: '501', username: 'ann', global_name: 'Ann' }, content, timestamp: new Date((T0 - ago) * 1000).toISOString(), type: 0, ...over };
};

test('the bot in a server: the channels it can see become sources, caught up from 24 hours back; bots, service notices and hidden channels are left out', async () => {
  const env = setup();
  const old = post(TEXT, 2 * 86_400, 'two days ago');
  const hello = post(TEXT, 3600, 'gm, ETH looks heavy');
  const bot = post(TEXT, 3000, 'MEE6: level up!', { author: { id: '9', username: 'MEE6', bot: true } });
  const answer = post(TEXT, 2400, 'agreed', { type: 19, author: { id: '502', username: 'bob' }, member: { nick: 'Bobby' } });
  answer.message_reference = { message_id: hello.id, channel_id: TEXT, guild_id: GUILD };
  const joined = post(TEXT, 2000, '', { type: 7 });
  const followed = post(NEWS, 1800, '', { author: { id: '77', username: 'Hyperliquid #announcements', bot: true }, webhook_id: '77', embeds: [{ title: 'HIP-3 is live' }], message_reference: { message_id: '5', channel_id: '6', guild_id: '7' } });
  env.history.set(TEXT, [old, hello, bot, answer, joined]);
  env.history.set(NEWS, [followed]);

  await env.reader.start();
  assert.equal(env.started(), 1, 'the token works: the gateway connects');
  env.dispatch('GUILD_CREATE', env.guild([
    { id: TEXT, type: 0, name: 'general' },
    { id: NEWS, type: 0, name: 'feeds' },
    { id: SECRET, type: 0, name: 'mods', permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] },
    { id: VOICE, type: 2, name: 'Lounge' },
  ]));
  await env.settle();
  const sources = env.store.listChats(false).filter((c) => c.platform === 'discord');
  assert.deepEqual(sources.map((c) => c.title), ['Ours · #general', 'Ours · #feeds'], 'a hidden channel and a voice channel are not sources');
  assert.ok(sources.every((c) => c.enabled && c.kind === 'watched'));
  assert.ok(env.events.some((e) => e.method === 'new channel' && e.target === 'Ours · #general'));

  // Caught up from 24 hours back: the two-day-old message is not fetched.
  assert.equal(env.asked[0].after, snowflakeAt(T0 - 86_400));
  const general = sources[0].chatId;
  const msgs = env.store.messages(general, 0, T0 + 1);
  assert.deepEqual(msgs.map((m) => m.text), ['gm, ETH looks heavy', 'agreed'], 'the bot and the join notice are not talk');
  assert.deepEqual(msgs.map((m) => m.messageId), [1, 2]);
  assert.equal(msgs[1].replyTo, 1, 'a reply points at the message it answers, by its id here');
  assert.equal(env.store.users(general).get(msgs[1].userId)!.displayName, 'Bobby', "the server nickname");
  assert.equal(env.store.discordChannel({ chatId: general })!.lastId, joined.id, 'the place moves past what was not kept too');

  // A post from a followed announcement channel is kept, and makes its channel a feed.
  const feeds = sources[1].chatId;
  assert.deepEqual(env.store.messages(feeds, 0, T0 + 1).map((m) => m.text), ['HIP-3 is live']);
  assert.equal(env.store.messages(feeds, 0, T0 + 1)[0].replyTo, null, 'its source is not a reply');
  assert.equal(env.store.discordChannel({ chatId: feeds })!.feed, true);
  assert.equal(env.stored.length, 3, 'the news radar sees each stored message');

  // Live: a new message is stored as it comes; an edit changes it; a channel switched off is not read.
  const live = post(TEXT, 10, 'breaking: ETF approved');
  env.dispatch('MESSAGE_CREATE', live);
  env.dispatch('MESSAGE_UPDATE', { id: live.id, channel_id: TEXT, content: 'breaking: ETF approved (official)' });
  assert.equal(env.store.messages(general, 0, T0 + 1).at(-1)!.text, 'breaking: ETF approved (official)');
  assert.equal(env.store.messages(general, 0, T0 + 1).at(-1)!.edited, true);
  env.store.updateChat(feeds, { enabled: false });
  env.dispatch('MESSAGE_CREATE', post(NEWS, 5, 'not read'));
  assert.equal(env.store.messages(feeds, 0, T0 + 1).length, 1);
  env.reader.stop();
  assert.ok(env.events.some((e) => e.method === 'stored' && e.target === 'Ours · #general'), 'the activity log says what was stored');
});

test('a channel the bot can no longer see, a deleted one, or the bot out of the server: the sources go; an outage keeps them', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }, { id: NEWS, type: 5, name: 'announcements' }]));
  await env.settle();
  const [general, news] = env.store.listChats(false).filter((c) => c.platform === 'discord').map((c) => c.chatId);
  env.hidden.add(TEXT);
  env.dispatch('CHANNEL_UPDATE', { id: TEXT, guild_id: GUILD, type: 0, name: 'general', permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] });
  await env.settle();
  assert.equal(env.store.getChat(general), null, 'hidden from the bot now (and Discord confirms it)');
  assert.ok(env.events.some((e) => e.method === 'source removed' && /cannot see it/.test(e.detail)));
  env.dispatch('GUILD_DELETE', { id: GUILD, unavailable: true });
  assert.ok(env.store.getChat(news), 'an outage is not a removal');
  env.dispatch('GUILD_DELETE', { id: GUILD });
  assert.equal(env.store.getChat(news), null, 'taken out of the server');
  env.reader.stop();
});

test('auto-watch off: new channels are listed switched off; switched on, a channel catches up from where it stopped, at most 24 hours back', async () => {
  const env = setup({ autoWatch: false });
  env.history.set(TEXT, [post(TEXT, 3600, 'one')]);
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const chat = env.store.listChats(false).find((c) => c.platform === 'discord')!;
  assert.equal(chat.enabled, false);
  assert.equal(env.store.getKv(`reader_off_reason:${chat.chatId}`), 'auto-watch off');
  assert.equal(env.asked.length, 0, 'nothing read while it is off');

  // Long ago it was read up to some message; switched on now with the console's 24-hour floor.
  env.store.updateDiscordChannel(chat.chatId, { lastId: snowflakeAt(T0 - 5 * 86_400) });
  env.store.setKv(`reader_floor:${chat.chatId}`, String(T0 - 86_400));
  env.store.updateChat(chat.chatId, { enabled: true });
  assert.equal(await env.reader.catchUp(env.store.getChat(chat.chatId)!), true);
  assert.equal(env.asked[0].after, snowflakeAt(T0 - 86_400));
  assert.equal(env.store.messages(chat.chatId, 0, T0 + 1).length, 1);

  // A long gap: pages of 100 until the present.
  env.history.set(TEXT, Array.from({ length: 250 }, (_, i) => post(TEXT, 3000 - i, `m${i}`)));
  assert.equal(await env.reader.catchUp(env.store.getChat(chat.chatId)!), true);
  assert.equal(env.store.messages(chat.chatId, 0, T0 + 1).length, 251);
  env.reader.stop();
});

test('a refused token: nothing connects, and the status says what to do', async () => {
  const env = setup();
  (env.rest as unknown as { me: () => Promise<never> }).me = async () => {
    throw new DiscordError(401, 0, '401: Unauthorized');
  };
  await env.reader.start();
  assert.equal(env.started(), 0);
  const s = env.reader.status();
  assert.equal(s.error, 'the bot token is not valid');
  assert.equal(s.invite, null);
  assert.ok(env.events.some((e) => e.method === 'not connected'));
  env.reader.stop();
});

test('the invite link asks only to view channels and read their history', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const s = env.reader.status();
  assert.equal(s.invite, `https://discord.com/oauth2/authorize?client_id=${BOT}&scope=bot&permissions=${(1 << 10) | (1 << 16)}`);
  assert.deepEqual(s.servers, [{ id: GUILD, name: 'Ours', channels: 1, on: 1 }]);
  assert.equal(s.bot?.name, 'pulse-bot');
  env.reader.stop();
});

test('a live message while a channel waits to catch up does not skip what came before it', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const chatId = env.store.listChats(false).find((c) => c.platform === 'discord')!.chatId;
  // Read up to 5 hours ago; then the service was off. Two messages came meanwhile.
  env.store.updateDiscordChannel(chatId, { lastId: snowflakeAt(T0 - 5 * 3600) });
  env.history.set(TEXT, [post(TEXT, 4 * 3600, 'missed 4h ago'), post(TEXT, 2 * 3600, 'missed 2h ago')]);
  env.state('connecting');
  // Back: a new session; a live message arrives before the channel's catch-up has run.
  env.state('online');
  env.dispatch('READY', { guilds: [{ id: GUILD }] });
  const live = post(TEXT, 5, 'just now');
  env.dispatch('MESSAGE_CREATE', live);
  assert.notEqual(env.store.discordChannel({ chatId })!.lastId, live.id, 'its place stays where the history is complete');
  env.history.get(TEXT)!.push(live);
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  assert.deepEqual(env.store.messages(chatId, 0, T0 + 1).map((m) => m.text).sort(), ['just now', 'missed 2h ago', 'missed 4h ago']);
  assert.equal(env.store.discordChannel({ chatId })!.lastId, live.id, 'caught up: now its place is the newest');
  // Up to date: live messages move the place again.
  const next = post(TEXT, 1, 'next');
  env.dispatch('MESSAGE_CREATE', next);
  assert.equal(env.store.discordChannel({ chatId })!.lastId, next.id);
  env.reader.stop();
});

test('one message Discord cannot date does not hold up the rest; a failed catch-up keeps its error and is tried again', async () => {
  const env = setup();
  env.history.set(TEXT, [post(TEXT, 3000, 'before'), post(TEXT, 2000, 'the year <t:9999999999999:R>'), post(TEXT, 1000, 'after')]);
  env.failOnce.add(TEXT);
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const chatId = env.store.listChats(false).find((c) => c.platform === 'discord')!.chatId;
  assert.equal(env.store.getChat(chatId)!.readerError, 'fetch failed', 'the reason shows');
  assert.equal(env.store.getKv(`reader_caught_up:${chatId}`), null, 'not "caught up"');
  assert.equal(env.store.messages(chatId, 0, T0 + 1).length, 0);
  env.fire(30_000); // tried again later
  await env.settle();
  assert.deepEqual(env.store.messages(chatId, 0, T0 + 1).map((m) => m.text), ['before', 'the year <t:9999999999999:R>', 'after']);
  assert.equal(env.store.getChat(chatId)!.readerError, null);
  assert.ok(env.store.getKv(`reader_caught_up:${chatId}`));
  env.reader.stop();
});

test('a channel is taken off only when Discord itself says the bot cannot see it, not on out-of-date roles', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const chatId = env.store.listChats(false).find((c) => c.platform === 'discord')!.chatId;
  // The server says @everyone may not see it (the bot's new role may, which the server did not say).
  const closed = { id: TEXT, guild_id: GUILD, type: 0, name: 'general', permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] };
  env.dispatch('CHANNEL_UPDATE', closed);
  await env.settle();
  assert.ok(env.store.getChat(chatId), 'Discord still shows it to the bot: kept');
  env.hidden.add(TEXT);
  env.dispatch('CHANNEL_UPDATE', closed);
  await env.settle();
  assert.equal(env.store.getChat(chatId), null, 'Discord refuses it: gone');
  env.reader.stop();
});

test('after time offline a channel catches up from where it stopped, back as far as messages are kept; switched on again, 24 hours', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const chat = env.store.listChats(false).find((c) => c.platform === 'discord')!;
  env.store.updateDiscordChannel(chat.chatId, { lastId: snowflakeAt(T0 - 30 * 3600) });
  env.history.set(TEXT, [post(TEXT, 28 * 3600, 'yesterday morning')]);
  assert.equal(await env.reader.catchUp(env.store.getChat(chat.chatId)!), true);
  assert.deepEqual(env.store.messages(chat.chatId, 0, T0 + 1).map((m) => m.text), ['yesterday morning'], 'not cut at 24 hours');
  env.reader.stop();
});

test('servers the bot left and channels deleted while it was away go; nothing is added without a report chat; a stop while starting stays stopped', async () => {
  const env = setup();
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }, { id: NEWS, type: 0, name: 'feeds' }]));
  await env.settle();
  assert.equal(env.store.discordChannels().length, 2);
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  assert.deepEqual(env.store.discordChannels().map((c) => c.name), ['general'], '#feeds was deleted meanwhile');
  env.dispatch('READY', { guilds: [] });
  assert.equal(env.store.discordChannels().length, 0, 'taken out of the server meanwhile');
  env.reader.stop();

  const none = setup({ reportTo: null });
  await none.reader.start();
  none.dispatch('GUILD_CREATE', none.guild([{ id: TEXT, type: 0, name: 'general' }]));
  assert.equal(none.store.discordChannels().length, 0);
  assert.match(none.reader.status().error!, /PULSE_OWNER_IDS/);
  none.reader.stop();

  const quick = setup();
  const starting = quick.reader.start();
  quick.reader.stop();
  await starting;
  assert.equal(quick.started(), 0, 'stopped before the token was checked: never connects');
});

test('the bot may see but not read history: said on the source; the Message Content intent off: nothing is read rather than read empty', async () => {
  const env = setup();
  await env.reader.start();
  const g = env.guild([{ id: TEXT, type: 0, name: 'general', permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: String(1 << 16) }] }]);
  env.dispatch('GUILD_CREATE', g);
  await env.settle();
  const chatId = env.store.discordChannels()[0].chatId;
  assert.match(env.store.getChat(chatId)!.readerError!, /not read its history/);

  env.gw.fatalCode = 4014;
  env.history.set(TEXT, [post(TEXT, 100, '')]);
  const before = env.asked.length;
  assert.equal(await env.reader.catchUp(env.store.getChat(chatId)!), false);
  assert.equal(env.asked.length, before, 'Discord is not asked');
  assert.match(env.store.getChat(chatId)!.readerError!, /Message Content intent is off/);
  env.reader.stop();
});

test('a forwarded message is stored as what it forwards, not as a reply', async () => {
  const env = setup();
  const original = post(TEXT, 3000, 'original');
  const fwd = post(TEXT, 2000, '', { message_reference: { type: 1, message_id: original.id, channel_id: TEXT }, message_snapshots: [{ message: { content: 'SEC approves the ETF' } }] });
  env.history.set(TEXT, [original, fwd]);
  await env.reader.start();
  env.dispatch('GUILD_CREATE', env.guild([{ id: TEXT, type: 0, name: 'general' }]));
  await env.settle();
  const msgs = env.store.messages(env.store.discordChannels()[0].chatId, 0, T0 + 1);
  assert.equal(msgs[1].text, '[forwarded] SEC approves the ETF');
  assert.equal(msgs[1].replyTo, null);
  env.reader.stop();
});
