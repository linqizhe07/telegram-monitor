import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api, type TelegramClient } from 'telegram';
import { Activity } from '../src/activity.ts';
import { Controller, PAD_LIMITS, reactionsOf, sendBlock } from '../src/controller.ts';
import { superviseRequests } from '../src/reader-client.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const big = (n: number | string) => n as never;
const DEFAULTS = { language: 'auto' as const, digestHour: 9, timezone: 'UTC', rsiMode: 'auto' as const };
const CHAT = -1000000001234;
const GROUP = -4001;
const PEER = JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' });

const channel = (o: Partial<Api.Channel> = {}) =>
  new Api.Channel({ id: big(1234), title: 'Alpha VIP', username: 'alpha_vip', accessHash: big('987'), megagroup: true, photo: new Api.ChatPhotoEmpty(), date: T0, ...o });
const rpc = (code: string) => Object.assign(new Error(code), { errorMessage: code });

/** What a group's bot posts with buttons under it: one to press, one into Telegram, one only the app can open. */
const withButtons = () =>
  new Api.Message({
    id: 77,
    peerId: new Api.PeerChannel({ channelId: big(1234) }),
    date: T0,
    message: 'Pick one',
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonCallback({ text: 'Yes', data: Buffer.from('vote:yes') }), new Api.KeyboardButtonUrl({ text: 'Rules', url: 'https://t.me/alpha_bot?start=rules' })] }),
        new Api.KeyboardButtonRow({ buttons: [new Api.KeyboardButtonWebView({ text: 'Open app', url: 'https://example.org/app' })] }),
      ],
    }),
  });

/** A Telegram behind the REAL request door: writes need the pad's one-shot permit. */
function setup(o: { channel?: Partial<Api.Channel>; full?: Record<string, unknown> } = {}) {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const activity = new Activity(store);
  store.watchChat({ chatId: CHAT, title: 'Alpha VIP', username: 'alpha_vip', type: 'supergroup', ref: '@alpha_vip', peer: PEER }, 42, null, DEFAULTS);
  const writes: ({ className: string } & Record<string, unknown>)[] = [];
  const reads: string[] = [];
  const answers = new Map<string, (req: Record<string, unknown>) => unknown>();
  const gram = {
    invoke: async (req: { className: string } & Record<string, unknown>) => {
      const a = answers.get(req.className);
      if (/^(channels|messages)\.Get(?!BotCallbackAnswer)/.test(req.className)) reads.push(req.className);
      else writes.push(req);
      if (!a) throw new Error(`unscripted ${req.className}`);
      return a(req);
    },
    invokeWithSender: async () => undefined,
  };
  const door = superviseRequests(gram as unknown as TelegramClient, activity, () => null, { intervalMs: 1, burst: 100 });
  answers.set('channels.GetFullChannel', () => ({
    fullChat: { availableReactions: new Api.ChatReactionsSome({ reactions: [new Api.ReactionEmoji({ emoticon: '👍' }), new Api.ReactionEmoji({ emoticon: '🔥' })] }), slowmodeSeconds: 0, notifySettings: { muteUntil: 0 }, unreadCount: 7, participantsCount: 500, ...o.full },
    chats: [channel(o.channel)],
  }));
  for (const w of ['messages.SendMessage', 'messages.SendReaction', 'messages.ForwardMessages', 'channels.LeaveChannel']) answers.set(w, () => ({ updates: [], users: [], chats: [] }));
  answers.set('channels.ReadHistory', () => true);
  answers.set('account.UpdateNotifySettings', () => true);
  answers.set('channels.GetMessages', () => ({ messages: [withButtons()] }));
  answers.set('messages.GetBotCallbackAnswer', () => ({ message: 'Counted.' }));
  const pulls: number[] = [];
  let lists = 0;
  const pad = new Controller({ raw: gram as unknown as TelegramClient, permit: door.permit, store, activity, now: clock.now, pullSoon: (id) => pulls.push(id), listSoon: () => lists++ });
  return { clock, store, activity, gram, door, pad, writes, reads, answers, pulls, lists: () => lists };
}

test('the pad: each press lets exactly its own request through, as the owner asked it', async () => {
  const t = setup();
  // Nothing writes without a press: the door refuses the request on its own.
  const unasked = () => t.gram.invoke(new Api.messages.SendMessage({ peer: new Api.InputPeerSelf(), message: 'gm, everyone', randomId: big(1) }) as never);
  await assert.rejects(unasked(), /WRITE_BLOCKED/);

  let r = await t.pad.send(CHAT, '  gm, everyone \n', null);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.message, 'Posted in «Alpha VIP».');
  const sent = t.writes.at(-1)!;
  assert.equal(sent.className, 'messages.SendMessage');
  assert.equal(sent.message, 'gm, everyone', 'trimmed, otherwise as typed');
  assert.equal((sent.peer as Api.InputPeerChannel).className, 'InputPeerChannel');
  assert.equal(sent.replyTo, undefined);
  assert.deepEqual(t.pulls, [CHAT], 'read again soon, so the post shows on the page');
  assert.equal(r.chat?.unread, 7);
  const ownerRows = t.store.activity().filter((a) => a.actor === 'owner');
  assert.ok(ownerRows.some((a) => a.method === 'messages.SendMessage' && /the owner's click/.test(a.detail)), 'recorded as the owner\'s write');
  assert.ok(ownerRows.some((a) => a.method === 'posted' && /«gm, everyone»/.test(a.detail)));

  // The permit was for that one request: the same words, unasked, are refused again.
  await assert.rejects(unasked(), /WRITE_BLOCKED/);

  r = await t.pad.send(CHAT, 'again', null);
  assert.equal(r.ok, false);
  assert.match(r.message, /One moment/, 'a person\'s pace');
  t.clock.t += PAD_LIMITS.send.gap;
  r = await t.pad.send(CHAT, 'yes, this', 42);
  assert.equal(r.ok, true);
  assert.equal((t.writes.at(-1)!.replyTo as Api.InputReplyToMessage).replyToMsgId, 42, 'a reply to the picked message');
  assert.equal(r.message, 'Replied to #42 in «Alpha VIP».');

  // Reactions: only the ones the chat allows, one emoji, or taken back.
  r = await t.pad.react(CHAT, 42, '🔥');
  assert.equal(r.ok, true, r.message);
  const reaction = t.writes.at(-1)!;
  assert.equal(reaction.className, 'messages.SendReaction');
  assert.equal(Number(reaction.msgId), 42);
  assert.deepEqual((reaction.reaction as Api.ReactionEmoji[]).map((x) => x.emoticon), ['🔥']);
  const before = t.writes.length;
  r = await t.pad.react(CHAT, 42, '😁');
  assert.equal(r.ok, false);
  assert.match(r.message, /allows only these reactions: 👍 🔥/);
  assert.equal((await t.pad.react(CHAT, 42, 'hello')).message, 'A reaction is one emoji.');
  assert.equal(t.writes.length, before, 'nothing sent for a refused one');
  t.clock.t += PAD_LIMITS.react.gap;
  r = await t.pad.react(CHAT, 42, null);
  assert.equal(r.ok, true);
  assert.deepEqual(t.writes.at(-1)!.reaction, [], 'taken back');

  // Saved Messages: a forward of that one message to the account itself.
  r = await t.pad.save(CHAT, 42);
  assert.equal(r.ok, true);
  const fwd = t.writes.at(-1)!;
  assert.equal(fwd.className, 'messages.ForwardMessages');
  assert.equal((fwd.toPeer as { className: string }).className, 'InputPeerSelf');
  assert.deepEqual(fwd.id, [42]);
  assert.ok(t.store.activity().some((a) => a.method === 'messages.ForwardMessages' && /Saved Messages/.test(a.detail)));

  // Mark read: up to the newest stored message.
  assert.match((await t.pad.markRead(CHAT)).message, /Nothing stored/);
  t.store.saveMessage({ chatId: CHAT, messageId: 90, threadId: null, userId: 5, date: T0, text: 'hi', replyTo: null, reactions: 0, edited: false });
  r = await t.pad.markRead(CHAT);
  assert.equal(r.ok, true);
  assert.equal(t.writes.at(-1)!.className, 'channels.ReadHistory');
  assert.equal(Number(t.writes.at(-1)!.maxId), 90);
  assert.equal(r.chat?.unread, 0);

  // Mute, then unmute: the chat's notifications on every device.
  r = await t.pad.mute(CHAT, true);
  assert.equal(r.ok, true);
  assert.equal(((t.writes.at(-1)!.settings as Api.InputPeerNotifySettings).muteUntil), 2_147_483_647);
  assert.equal(r.chat?.muted, true);
  t.clock.t += PAD_LIMITS.mute.gap;
  r = await t.pad.mute(CHAT, false);
  assert.equal(((t.writes.at(-1)!.settings as Api.InputPeerNotifySettings).muteUntil), 0);
  assert.equal(r.chat?.muted, false);

  // A message's bot buttons: what each may do, and never its callback data.
  const keys = await t.pad.buttons(CHAT, 77);
  assert.equal(keys.ok, true);
  assert.deepEqual(keys.rows!.map((row) => row.map((k) => [k.label, k.kind])), [[['Yes', 'press'], ['Rules', 'telegram']], [['Open app', 'app']]]);
  assert.ok(!JSON.stringify(keys).includes('vote:yes'), 'callback data stays in the service');
  assert.match((await t.pad.press(CHAT, 77, 0, 1)).message, /opens Telegram/);
  assert.match((await t.pad.press(CHAT, 77, 1, 0)).message, /Telegram app/);
  r = await t.pad.press(CHAT, 77, 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Pressed «Yes». The bot said: Counted.');
  assert.equal(Buffer.from(t.writes.at(-1)!.data as Uint8Array).toString(), 'vote:yes', 'the exact data of the button the owner picked');

  // Leaving: the chat-list check then takes it off Sources.
  r = await t.pad.leave(CHAT);
  assert.equal(r.ok, true);
  assert.equal(t.writes.at(-1)!.className, 'channels.LeaveChannel');
  assert.equal(t.lists(), 1);
  assert.ok(t.store.activity().some((a) => a.actor === 'owner' && a.method === 'left'));
});

test('the pad refuses before sending: a channel it cannot post in, a restricted account, protected content, slow mode', async () => {
  const bc = setup({ channel: { broadcast: true, megagroup: false } });
  let r = await bc.pad.send(CHAT, 'hello', null);
  assert.equal(r.ok, false);
  assert.match(r.message, /only its admins post/);
  assert.equal(bc.writes.length, 0);

  const muted = setup({ channel: { bannedRights: new Api.ChatBannedRights({ sendMessages: true, untilDate: 0 }) } });
  assert.match((await muted.pad.send(CHAT, 'hello', null)).message, /restricted the account from posting/);

  const prot = setup({ channel: { noforwards: true } });
  assert.match((await prot.pad.save(CHAT, 5)).message, /protects its content/);
  assert.equal(prot.writes.length, 0);

  const slow = setup({ full: { slowmodeSeconds: 60, slowmodeNextSendDate: T0 + 30 } });
  r = await slow.pad.send(CHAT, 'hello', null);
  assert.match(r.message, /slow mode on: the account can post again in 30s/);
  assert.equal(slow.writes.length, 0);

  const none = setup({ full: { availableReactions: new Api.ChatReactionsNone() } });
  assert.match((await none.pad.react(CHAT, 5, '👍')).message, /allows no reactions/);

  const out = setup({ channel: { left: true } });
  assert.match((await out.pad.send(CHAT, 'hello', null)).message, /join it first/);
  assert.match((await out.pad.markRead(CHAT)).message, /nothing to mark|Nothing stored/);

  assert.equal((await out.pad.send(-1009, 'hello', null)).message, 'Pick one of your sources first.');
  out.store.watchChat({ chatId: GROUP, title: 'No address', username: null, type: 'group', ref: String(GROUP) }, 42, null, DEFAULTS);
  assert.match((await out.pad.send(GROUP, 'hello', null)).message, /No saved address/);
});

test('the pad holds back what others see when Telegram says PEER_FLOOD, and keeps a person\'s pace', async () => {
  const t = setup();
  t.answers.set('messages.SendMessage', () => {
    throw rpc('PEER_FLOOD');
  });
  let r = await t.pad.send(CHAT, 'hello', null);
  assert.equal(r.ok, false);
  assert.match(r.message, /suspects spam/);
  t.clock.t += 10;
  assert.match((await t.pad.react(CHAT, 1, '👍')).message, /Nothing other people would see goes out until/);
  r = await t.pad.save(CHAT, 1);
  assert.equal(r.ok, true, 'saving to Saved Messages is the owner\'s own: it still goes');
  t.clock.t += 86_400;
  t.answers.set('messages.SendMessage', () => {
    throw rpc('SLOWMODE_WAIT_42');
  });
  assert.match((await t.pad.send(CHAT, 'hello', null)).message, /slow mode on: the account can post again in 42s/);

  // An hour's ration of posts, then no more until the first of them is an hour old.
  const p = setup();
  for (let i = 0; i < PAD_LIMITS.send.perHour; i++) {
    p.clock.t += PAD_LIMITS.send.gap;
    assert.equal((await p.pad.send(CHAT, `n${i}`, null)).ok, true);
  }
  p.clock.t += PAD_LIMITS.send.gap;
  assert.match((await p.pad.send(CHAT, 'one more', null)).message, /30 posts in the last hour already/);
  assert.equal(p.writes.filter((w) => w.className === 'messages.SendMessage').length, PAD_LIMITS.send.perHour);
});

test('what a chat allows, from its own rights', () => {
  const now = T0;
  assert.equal(sendBlock({ megagroup: true } as never, now), null);
  assert.match(sendBlock({ broadcast: true }, now)!, /only its admins post/);
  assert.equal(sendBlock({ broadcast: true, adminRights: { postMessages: true } }, now), null);
  assert.match(sendBlock({ defaultBannedRights: { sendMessages: true } }, now)!, /Only admins can post/);
  assert.equal(sendBlock({ defaultBannedRights: { sendMessages: true }, creator: true }, now), null);
  assert.equal(sendBlock({ bannedRights: { sendMessages: true, untilDate: now - 10 } }, now), null, 'a restriction that is over');
  assert.match(sendBlock({ bannedRights: { sendMessages: true, untilDate: now + 3600 } }, now)!, /until/);
  assert.equal(reactionsOf(undefined), null);
  assert.equal(reactionsOf({ className: 'ChatReactionsAll' }), null);
  assert.deepEqual(reactionsOf({ className: 'ChatReactionsNone' }), []);
  assert.deepEqual(reactionsOf({ className: 'ChatReactionsSome', reactions: [{ className: 'ReactionEmoji', emoticon: '👍' }, { className: 'ReactionCustomEmoji' }] }), ['👍']);
});

test('the pad never sends one press twice: on its way, a moment later, or while Telegram has the account waiting', async () => {
  const { errors } = await import('telegram');
  const t = setup();
  // A post that hangs at the door (a hold, a dropped line): the same press again is refused, not queued.
  let release: (v: unknown) => void = () => undefined;
  t.answers.set('messages.SendMessage', () => new Promise((r) => (release = r)));
  const first = t.pad.send(CHAT, 'gm', null);
  await new Promise((r) => setTimeout(r, 20));
  t.clock.t += PAD_LIMITS.send.gap;
  const again = await t.pad.send(CHAT, 'gm', null);
  assert.equal(again.ok, false);
  assert.match(again.message, /still on its way/);
  release({ updates: [] });
  assert.equal((await first).ok, true);
  t.clock.t += PAD_LIMITS.send.gap;
  assert.match((await t.pad.send(CHAT, 'gm', null)).message, /posted exactly this here a moment ago/, 'a double press is not a second post');
  assert.equal(t.writes.filter((w) => w.className === 'messages.SendMessage').length, 1);
  t.clock.t += 31;
  t.answers.set('messages.SendMessage', () => ({ updates: [] }));
  assert.equal((await t.pad.send(CHAT, 'gm', null)).ok, true, 'later it is a new post');

  // A chat's slow mode from GramJS: said as such.
  t.clock.t += PAD_LIMITS.send.gap;
  t.answers.set('messages.SendMessage', (req) => {
    throw new errors.SlowModeWaitError({ capture: 42, request: req as never });
  });
  assert.match((await t.pad.send(CHAT, 'later', null)).message, /slow mode on: the account can post again in 42s/);

  // Telegram has the account waiting, or the line is down: nothing is even tried.
  let held = 0;
  let up = true;
  const h = setup();
  const pad = new Controller({ raw: h.gram as unknown as TelegramClient, permit: h.door.permit, store: h.store, activity: h.activity, now: h.clock.now, held: () => held, online: () => up });
  held = Date.now() + 60_000;
  assert.match((await pad.send(CHAT, 'hello', null)).message, /asked the account to wait until/);
  assert.match((await pad.react(CHAT, 5, '👍')).message, /asked the account to wait until/);
  held = 0;
  up = false;
  assert.match((await pad.save(CHAT, 5)).message, /not reachable/);
  assert.equal(h.writes.length, 0);
});

test("muting keeps the chat's own sound and previews, and PEER_FLOOD holds joining as well", async () => {
  const sound = new Api.NotificationSoundLocal({ title: 'Chime', data: 'chime' });
  const t = setup({ full: { notifySettings: new Api.PeerNotifySettings({ showPreviews: false, otherSound: sound, storiesMuted: true }) } });
  const r = await t.pad.mute(CHAT, true);
  assert.equal(r.ok, true, r.message);
  const settings = t.writes.at(-1)!.settings as Api.InputPeerNotifySettings;
  assert.equal(settings.muteUntil, 2_147_483_647);
  assert.equal(settings.showPreviews, false, 'previews stay off');
  assert.equal(settings.sound, sound, 'the chime stays');
  assert.equal(settings.storiesMuted, true);

  t.answers.set('messages.SendReaction', () => {
    throw rpc('PEER_FLOOD');
  });
  await t.pad.react(CHAT, 5, '👍');
  const { OwnerActions } = await import('../src/owner-actions.ts');
  const owner = new OwnerActions({ raw: t.gram as unknown as TelegramClient, permit: t.door.permit, store: t.store, activity: t.activity, tracker: {} as never, now: t.clock.now });
  const budget = owner.joinBudget();
  assert.equal(budget.ok, false);
  assert.match(budget.message, /suspects spam/, 'the pad\'s PEER_FLOOD holds joins too');
});
