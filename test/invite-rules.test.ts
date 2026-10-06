import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Api } from 'telegram';
import {
  BUDGET,
  classifyInvite,
  classifySelf,
  deepLinks,
  formatInviteStatus,
  inviteHash,
  InviteBudget,
  matchChallenge,
  pendingSchedule,
  verifySchedule,
  warningsFor,
  type InviteAnswer,
} from '../src/invite-rules.ts';
import { parseRef, type MtMessage } from '../src/reader.ts';
import { Clock, memoryStore, T0 } from './helpers.ts';

const big = (n: number | string) => n as never;
const at = (t: number) => `t${t}`;

test('what an invite check answered: member, preview, open, request, paid, scam', () => {
  const channel = new Api.Channel({ id: big(1234), title: 'Alpha VIP', accessHash: big('987'), megagroup: true, photo: new Api.ChatPhotoEmpty(), date: T0 });
  const member = classifyInvite(new Api.ChatInviteAlready({ chat: channel }) as unknown as InviteAnswer);
  assert.equal(member.verdict, 'member');
  assert.equal(member.chat!.chatId, -1000000001234);
  assert.equal(member.chat!.peer, JSON.stringify({ type: 'channel', id: '1234', accessHash: '987' }));
  assert.equal(member.kind, 'supergroup');

  const basic = classifyInvite(new Api.ChatInviteAlready({ chat: new Api.Chat({ id: big(55), title: 'Old basic', photo: new Api.ChatPhotoEmpty(), participantsCount: 3, date: T0, version: 1 }) }) as unknown as InviteAnswer);
  assert.equal(basic.verdict, 'member');
  assert.equal(basic.kind, 'group');
  assert.equal(basic.chat!.peer, JSON.stringify({ type: 'chat', id: '55' }));

  const peek = classifyInvite(new Api.ChatInvitePeek({ chat: channel, expires: T0 + 600 }) as unknown as InviteAnswer);
  assert.equal(peek.verdict, 'peek');
  assert.equal(peek.peekUntil, T0 + 600);

  const invite = (o: Partial<Api.ChatInvite>) =>
    classifyInvite(new Api.ChatInvite({ title: 'Whales', photo: new Api.PhotoEmpty({ id: big(0) }), participantsCount: 812, color: 0, megagroup: true, ...o }) as unknown as InviteAnswer);
  assert.equal(invite({}).verdict, 'join');
  assert.equal(invite({}).members, 812);
  assert.equal(invite({ requestNeeded: true }).verdict, 'request');
  assert.equal(invite({ scam: true }).verdict, 'refused');
  assert.equal(invite({ fake: true }).verdict, 'refused');
  assert.equal(invite({ subscriptionPricing: new Api.StarsSubscriptionPricing({ period: 2592000, amount: big(100) }) }).verdict, 'paid');
  assert.equal(invite({ broadcast: true, megagroup: false }).kind, 'channel');
  assert.equal(invite({ megagroup: false }).kind, 'group');
});

test('warnings before joining: only the ones that apply, each with its evidence', () => {
  const base = { title: 'Whales', scam: false, fake: false, peekUntil: null };
  const codes = (v: Parameters<typeof warningsFor>[0]) => warningsFor(v, at).map((w) => w.code);
  assert.ok(codes({ ...base, verdict: 'request' }).includes('request'));
  assert.ok(codes({ ...base, verdict: 'request' }).includes('guard-miniapp'));
  assert.ok(!codes({ ...base, verdict: 'join' }).includes('request'));
  assert.ok(!codes({ ...base, verdict: 'join' }).includes('guard-miniapp'));
  assert.equal(warningsFor({ ...base, verdict: 'paid' }, at)[0].level, 'stop');
  assert.deepEqual(codes({ ...base, verdict: 'refused', scam: true }), ['scam-flag']);
  assert.match(warningsFor({ ...base, verdict: 'peek', peekUntil: 99 }, at).find((w) => w.code === 'peek')!.text, /until t99/);
  assert.ok(codes({ ...base, verdict: 'join', title: '币安 VIP 内部群' }).includes('brand'));
  assert.ok(!codes({ ...base, verdict: 'join' }).includes('brand'));
  for (const w of warningsFor({ ...base, verdict: 'request' }, at)) assert.ok(w.evidence.length > 0, `${w.code} cites evidence`);
});

test('invite links: only a clean hash goes into a link; folder and members-only links are recognised', () => {
  assert.deepEqual(deepLinks('AbCdEfGh1234'), { tme: 'https://t.me/+AbCdEfGh1234', tg: 'tg://join?invite=AbCdEfGh1234' });
  for (const bad of ['AbCd/EfGh1234', 'AbCdEfGh?x=1', 'AbCd"EfGh12', 'AbCd EfGh12', 'short']) assert.throws(() => deepLinks(bad));
  assert.equal(inviteHash('https://t.me/+AbCdEfGh1234'), 'AbCdEfGh1234');
  assert.equal(inviteHash('t.me/joinchat/AbCdEfGh1234'), 'AbCdEfGh1234');
  assert.equal(inviteHash('tg://join?invite=AbCdEfGh1234'), 'AbCdEfGh1234');
  assert.equal(inviteHash('@binancechinese'), null);
  assert.deepEqual(parseRef('https://t.me/addlist/AbCdEf'), { kind: 'chatlist', slug: 'AbCdEf' });
  assert.deepEqual(parseRef('tg://addlist?slug=AbCdEf'), { kind: 'chatlist', slug: 'AbCdEf' });
  assert.deepEqual(parseRef('https://t.me/c/123/45'), { kind: 'id', value: -1000000000123 });
  assert.deepEqual(parseRef('tg://privatepost?channel=123&post=45'), { kind: 'id', value: -1000000000123 });
});

test('the ration: 20 a day, 12 scheduled, 5 from Claude, spaced out, frozen after a flood', () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const b = new InviteBudget(store, clock.now);
  assert.equal(b.take('owner').ok, true);
  const spaced = b.take('owner');
  assert.equal(spaced.ok, false);
  assert.equal(!spaced.ok && spaced.retryAt, T0 + BUDGET.minGap);
  clock.t += 30;
  assert.equal(b.take('background').ok, false, 'a scheduled check waits 2 minutes after any check');
  clock.t += 90;
  assert.equal(b.take('background').ok, true);

  for (let i = 0; i < 6; i++) {
    clock.t += 31;
    b.take('mcp');
  }
  assert.equal(b.view().mcp24h, 5, 'Claude gets 5 a day');
  for (let i = 0; i < 30; i++) {
    clock.t += 31;
    b.take('owner');
  }
  assert.equal(b.view().used24h, 20, 'never more than 20 in 24 hours');
  clock.t += 86_400;
  assert.equal(b.take('owner').ok, true, 'the ration renews');

  const frozen = b.flood(600);
  assert.equal(frozen, clock.t + 6 * 3600, 'a short wait still pauses invite checks for 6 hours');
  assert.equal(b.take('owner').ok, false);
  clock.t += 7 * 3600;
  assert.equal(b.flood(30_000), clock.t + 86_400, 'a second flood within a day: 24 hours');
  clock.t += 3 * 86_400;
  assert.equal(b.flood(30_000), clock.t + 60_000, 'a long wait doubles');
});

test('schedules: a pending request is checked 17 times over 14 days; a waiting check over 7 days', () => {
  const s = (n: number) => pendingSchedule(T0, n);
  assert.deepEqual([s(0), s(1), s(2), s(3), s(4)], [T0, T0 + 3600, T0 + 6 * 3600, T0 + 86_400, T0 + 2 * 86_400]);
  assert.equal(s(16), T0 + 14 * 86_400);
  assert.equal(s(17), null);
  assert.equal(verifySchedule(T0, 0), T0 + 60);
  assert.equal(verifySchedule(T0, 7), T0 + 86_400);
  assert.equal(verifySchedule(T0, 13), T0 + 7 * 86_400);
  assert.equal(verifySchedule(T0, 14), null);
});

test("the account's own standing: from the chat first, then its participant entry, then the error", () => {
  const rights = (o: Partial<Api.ChatBannedRights>) => new Api.ChatBannedRights({ untilDate: 0, ...o });
  const ch = (o: Partial<Api.Channel>) => new Api.Channel({ id: big(1), title: 'G', photo: new Api.ChatPhotoEmpty(), date: T0, megagroup: true, ...o });
  const st = (i: Parameters<typeof classifySelf>[0]) => classifySelf(i, T0);
  assert.equal(st({ chat: ch({}) as never }).state, 'member');
  assert.equal(st({ chat: ch({ bannedRights: rights({ sendMessages: true }) }) as never }).state, 'verifying', 'muted: a check is likely waiting');
  assert.equal(st({ chat: ch({ bannedRights: rights({ sendMessages: true }), defaultBannedRights: rights({ sendMessages: true }) }) as never }).state, 'member', 'everyone is muted: not about this account');
  const media = st({ chat: ch({ bannedRights: rights({ sendMedia: true }) }) as never });
  assert.equal(media.state, 'member');
  assert.match(media.detail, /media restricted/);
  assert.equal(st({ chat: ch({ bannedRights: rights({ sendMessages: true, untilDate: T0 - 5 }) }) as never }).state, 'member', 'a mute that has run out');
  assert.equal(st({ chat: ch({ left: true }) as never }).state, 'removed');
  const forbidden = (untilDate?: number) => new Api.ChannelForbidden({ id: big(1), accessHash: big(2), title: 'G', megagroup: true, untilDate });
  assert.deepEqual(st({ chat: forbidden(T0 + 45) as never }), { state: 'banned-until', until: T0 + 45, detail: 'removed by the group until this time (a kick or a timed ban)' });
  assert.equal(st({ chat: forbidden() as never }).state, 'banned');
  assert.equal(st({ chat: forbidden(T0 + 400 * 86_400) as never }).state, 'banned', 'more than a year out is a ban');
  const self = st({ participant: new Api.ChannelParticipantSelf({ userId: big(8), inviterId: big(9), date: T0 - 30, viaRequest: true }) as never });
  assert.equal(self.viaRequest, true);
  assert.equal(self.joinedAt, T0 - 30);
  assert.equal(st({ participant: new Api.ChannelParticipantBanned({ left: true, peer: new Api.PeerUser({ userId: big(8) }), kickedBy: big(1), date: T0, bannedRights: rights({ viewMessages: true }) }) as never }).state, 'banned');
  assert.equal(st({ error: 'USER_NOT_PARTICIPANT' }).state, 'removed');
  assert.equal(st({ chat: new Api.Chat({ id: big(5), title: 'b', photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: T0, version: 1, left: true }) as never }).state, 'removed');
  assert.match(st({ chat: new Api.Chat({ id: big(5), title: 'b', photo: new Api.ChatPhotoEmpty(), participantsCount: 1, date: T0, version: 1, deactivated: true }) as never }).detail, /upgraded/);
});

test('which bot messages address the account; button data is tested, never kept', () => {
  const self = { id: '7000000042', username: 'reader_bot' };
  const bot = { className: 'User', id: 777, username: 'shieldy_bot', firstName: 'Shieldy', bot: true };
  const msg = (o: Partial<MtMessage>): MtMessage => ({ id: 10, date: T0, message: 'Welcome! Press the button', sender: bot, ...o });
  const button = (data: string, text = 'I am not a bot') => new Api.KeyboardButtonCallback({ text, data: Buffer.from(data) });
  const markup = (...b: unknown[]) => new Api.ReplyInlineMarkup({ rows: [new Api.KeyboardButtonRow({ buttons: b as never })] }) as never;

  const shieldy = matchChallenge(msg({ replyMarkup: markup(button(`-1001234~${self.id}`), new Api.KeyboardButtonUrl({ text: 'Rules', url: 'https://example.org/rules?x=secret' })) }), self, T0 - 30, -1001234);
  assert.ok(shieldy);
  assert.deepEqual(shieldy.why, ['a button carries your account id']);
  assert.deepEqual(shieldy.buttons, ['I am not a bot', 'Rules (link to example.org, not opened here)']);
  const json = JSON.stringify(shieldy);
  assert.ok(!json.includes('~') && !json.includes('secret') && !json.includes('data'), 'no button data, no full URL');

  assert.equal(matchChallenge(msg({ replyMarkup: markup(button('-1001234~999')) }), self, T0 - 30, -1), null, 'someone else\'s check');
  assert.ok(matchChallenge(msg({ replyMarkup: markup(button(`button_captcha ${self.id}`)) }), self, T0 - 30, -1));
  assert.equal(matchChallenge(msg({ replyMarkup: markup(button(`button_captcha 1${self.id}0`)) }), self, T0 - 30, -1), null, 'the id inside a longer number');
  assert.deepEqual(matchChallenge(msg({ entities: [new Api.MessageEntityMentionName({ offset: 0, length: 3, userId: big(self.id) }) as never] }), self, T0 - 30, -1)!.why, ['it mentions you']);
  assert.ok(matchChallenge(msg({ mentioned: true }), self, T0 - 30, -1));
  assert.ok(matchChallenge(msg({ message: 'hey @Reader_Bot solve 2+2' }), self, T0 - 30, -1));
  assert.equal(matchChallenge(msg({ message: 'hey @reader_bott' }), self, T0 - 30, -1), null);
  assert.equal(matchChallenge(msg({ mentioned: true, sender: { className: 'User', id: 5, firstName: 'A person' } }), self, T0 - 30, -1), null, 'people are not checks');
  const via = matchChallenge(msg({ mentioned: true, sender: { className: 'User', id: 5, firstName: 'A person' }, viaBotId: 999 }), self, T0 - 30, -1);
  assert.match(via!.suspicious!, /not a real check/);
  assert.equal(matchChallenge(msg({ mentioned: true, date: T0 - 3600 }), self, T0 - 30, -1), null, 'from before the join');
});

test("what Claude may see: states and times, never a check's text, its buttons or a full hash", () => {
  const clock = new Clock(T0);
  const store = memoryStore(clock);
  const inv = store.addInvite({ hash: 'AbCdEfGh1234', origin: 'console', state: 'requested', verdict: 'request', title: 'Whales', nextCheckAt: T0 + 3600 });
  store.setMembership(-1000000001234, { state: 'verifying', cause: 'bot message', joinedAt: T0 - 60, checkedAt: T0, detail: 'Press the button within 60s' });
  const out = formatInviteStatus([store.getInvite(inv.id)!], [{ ...store.membership(-1000000001234)!, title: 'Alpha VIP' }], { used24h: 3, perDay: 20, frozenUntil: null }, T0, 'UTC');
  assert.match(out, /«Whales» \(invite AbCd…\) · requested/);
  assert.match(out, /Answer it in your Telegram app\. I can't see or answer it\./);
  assert.ok(!out.includes('AbCdEfGh1234'), 'no full hash');
  assert.ok(!out.includes('Press the button'), 'no check text');
  assert.match(out, /3 of 20/);
});
