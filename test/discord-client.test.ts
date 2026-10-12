import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DiscordError,
  DiscordGateway,
  DiscordRest,
  INTENTS,
  discordText,
  isTalk,
  newer,
  snowflakeAt,
  snowflakeTime,
  type DiscordCall,
  type DiscordMessage,
  type GatewaySocket,
} from '../src/discord-client.ts';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('REST: GET only, with the bot token; it waits out an empty bucket and a 429, and says what an error means', async () => {
  let clock = 1_000_000;
  const slept: number[] = [];
  const asked: { url: string; auth: string | undefined }[] = [];
  const answers = [
    reply(200, [{ id: '1' }], { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' }),
    reply(429, { retry_after: 1.5, global: false }),
    reply(200, [{ id: '2' }]),
    reply(403, { code: 50001, message: 'Missing Access' }),
  ];
  const calls: DiscordCall[] = [];
  const rest = new DiscordRest('TOKEN', {
    fetch: async (url, init) => {
      asked.push({ url, auth: init?.headers?.Authorization });
      return answers.shift()!;
    },
    record: (c) => calls.push(c),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.deepEqual(await rest.messages('42', { after: '7' }), [{ id: '1' }]);
  assert.equal(asked[0].url, 'https://discord.com/api/v10/channels/42/messages?limit=100&after=7');
  assert.equal(asked[0].auth, 'Bot TOKEN');
  // The bucket is empty for 2.5 s; then Discord says 429 and 1.5 s more.
  assert.deepEqual(await rest.messages('42', { after: '1' }), [{ id: '2' }]);
  assert.deepEqual(slept, [2500, 1500]);
  await assert.rejects(rest.channels('9'), (err: unknown) => err instanceof DiscordError && err.reason === 'the bot cannot see this channel');
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.status]), [
    ['GET', '/channels/42/messages', 200],
    ['GET', '/channels/42/messages', 429],
    ['GET', '/channels/42/messages', 200],
    ['GET', '/guilds/9/channels', 403],
  ]);
  // There is no way to send anything: the client has no method for it.
  assert.equal(Object.getOwnPropertyNames(DiscordRest.prototype).filter((k) => /post|put|patch|delete|send/i.test(k)).length, 0);
});

/** A gateway connection the test plays Discord's side of. */
function fakeDiscord() {
  const sockets: (GatewaySocket & { url: string; sent: { op: number; d: unknown }[]; closedWith: number | null })[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const states: string[] = [];
  const events: string[] = [];
  const gw = new DiscordGateway('TOKEN', {
    connect: (url) => {
      const s = {
        url,
        sent: [] as { op: number; d: unknown }[],
        closedWith: null as number | null,
        send(data: string) {
          s.sent.push(JSON.parse(data));
        },
        close(code?: number) {
          s.closedWith = code ?? 1000;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as GatewaySocket & { url: string; sent: { op: number; d: unknown }[]; closedWith: number | null };
      sockets.push(s);
      return s;
    },
    onDispatch: (t) => events.push(t),
    onState: (st, err) => states.push(err ? `${st}: ${err}` : st),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) (t as { live: boolean }).live = false;
    },
    random: () => 0.5,
  });
  const say = (s: GatewaySocket, payload: unknown) => s.onmessage!({ data: JSON.stringify(payload) });
  const fire = (ms?: number) => {
    const t = timers.find((x) => x.live && (ms === undefined || x.ms === ms));
    assert.ok(t, `a timer${ms ? ` of ${ms} ms` : ''} is waiting`);
    t.live = false;
    t.fn();
  };
  return { gw, sockets, timers, states, events, say, fire };
}

test('gateway: identifies with the three intents, heartbeats with the last sequence, resumes a dropped connection', () => {
  const d = fakeDiscord();
  d.gw.start();
  const first = d.sockets[0];
  assert.equal(first.url, 'wss://gateway.discord.gg/?v=10&encoding=json');
  d.say(first, { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null });
  assert.deepEqual(first.sent[0], { op: 2, d: { token: 'TOKEN', intents: INTENTS, properties: { os: process.platform, browser: 'tg-pulse', device: 'tg-pulse' } } });
  assert.equal(INTENTS, 1 + 512 + 32768, 'GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT');
  d.say(first, { op: 0, t: 'READY', s: 1, d: { session_id: 'S', resume_gateway_url: 'wss://resume.discord.gg', user: { id: '99', username: 'pulse' } } });
  d.say(first, { op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '5' } });
  assert.equal(d.gw.state, 'online');
  assert.equal(d.gw.user?.username, 'pulse');
  assert.deepEqual(d.events, ['READY', 'MESSAGE_CREATE']);
  d.fire(20_000); // the first heartbeat comes after a random part of the interval
  assert.deepEqual(first.sent.at(-1), { op: 1, d: 2 });
  d.say(first, { op: 11, d: null, s: null, t: null });

  // The connection drops: a new one to the resume address, resuming the session where it was.
  first.onclose!({ code: 1006 });
  assert.equal(d.gw.state, 'connecting');
  d.fire(1000);
  const second = d.sockets[1];
  assert.equal(second.url, 'wss://resume.discord.gg/?v=10&encoding=json');
  d.say(second, { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null });
  assert.deepEqual(second.sent[0], { op: 6, d: { token: 'TOKEN', session_id: 'S', seq: 2 } });
  d.say(second, { op: 0, t: 'RESUMED', s: 3, d: null });
  assert.equal(d.gw.state, 'online');

  // A heartbeat that goes unanswered: the connection is dead, so it reconnects.
  d.fire(20_000);
  d.fire(40_000);
  assert.equal(second.closedWith, 4000);
  assert.equal(d.gw.state, 'connecting');
});

test('gateway: a refused token or a switched-off Message Content intent stops it with what to do; an invalid session starts over', () => {
  const d = fakeDiscord();
  d.gw.start();
  d.say(d.sockets[0], { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null });
  d.sockets[0].onclose!({ code: 4014 });
  assert.equal(d.gw.state, 'stopped');
  assert.match(d.gw.error!, /Message Content intent is off/);
  assert.equal(d.timers.filter((t) => t.live && t.ms === 1000).length, 0, 'it does not keep trying');

  const e = fakeDiscord();
  e.gw.start();
  e.say(e.sockets[0], { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null });
  e.say(e.sockets[0], { op: 0, t: 'READY', s: 1, d: { session_id: 'S', resume_gateway_url: 'wss://resume.discord.gg', user: { id: '1', username: 'b' } } });
  e.say(e.sockets[0], { op: 9, d: false, s: null, t: null });
  e.fire(2000);
  const next = e.sockets[1];
  assert.equal(next.url, 'wss://gateway.discord.gg/?v=10&encoding=json', 'a fresh session, not a resume');
  e.say(next, { op: 10, d: { heartbeat_interval: 40_000 }, s: null, t: null });
  assert.equal(next.sent[0].op, 2, 'identifies again');

  const f = fakeDiscord();
  f.gw.start();
  f.sockets[0].onclose!({ code: 4004 });
  assert.match(f.gw.error!, /refused the bot token/);
});

test('a message as text: mentions by name, emoji, embeds, media as placeholders; bots and service notices are not talk', () => {
  const m = (over: Partial<DiscordMessage>): DiscordMessage => ({ id: '1', channel_id: '2', author: { id: '3', username: 'ann' }, content: '', timestamp: '2026-10-09T10:00:00Z', type: 0, ...over });
  const text = discordText(
    m({
      content: 'gm <@11> see <#22> <@&33> <:pepe:44> at <t:1791460800:R>',
      mentions: [{ id: '11', username: 'bob', global_name: 'Bob' }],
      embeds: [{ title: 'HIP-3 is live', description: 'Builder-deployed perps' }],
      attachments: [{ filename: 'chart.png', content_type: 'image/png' }, { filename: 'notes.pdf', content_type: 'application/pdf' }],
      sticker_items: [{ name: 'wave' }],
    }),
    (id) => (id === '22' ? 'announcements' : null),
  );
  assert.equal(text, 'gm @Bob see #announcements @role :pepe: at 2026-10-08 12:00 UTC\nHIP-3 is live\nBuilder-deployed perps\n[photo]\n[file notes.pdf]\n[sticker wave]');
  assert.ok(isTalk(m({ content: 'hi' })));
  assert.ok(isTalk(m({ type: 19 })), 'a reply');
  assert.ok(!isTalk(m({ author: { id: '9', username: 'MEE6', bot: true } })), 'a bot');
  assert.ok(isTalk(m({ author: { id: '9', username: 'Hyperliquid #announcements', bot: true }, webhook_id: '9' })), 'a post from a followed announcement channel');
  assert.ok(!isTalk(m({ type: 7 })), 'someone joined');
});

test('snowflakes: compared exactly, and to and from a time', () => {
  assert.ok(newer('1230000000000000001', '1230000000000000000'), 'beyond what a double tells apart');
  assert.ok(newer('5', null));
  const t = 1_791_460_800;
  assert.equal(snowflakeTime(snowflakeAt(t)), t);
  assert.equal(snowflakeTime('175928847299117063'), 1462015105.796);
});
