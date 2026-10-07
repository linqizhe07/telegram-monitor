// A read-only look at a group or channel before anything is joined: what the reader account can see
// from outside, and what stands at the door (join approval, hidden history, the bots that guard it).
// It never joins, posts, reacts, or marks anything read.

import { Api, type TelegramClient } from 'telegram';
import { perDayOf } from './discover-rules.ts';
import { explain, FOLDER_LINK, parseRef } from './reader.ts';

export type Verdict = 'read-from-outside' | 'member' | 'join-needed' | 'request-needed' | 'unsafe' | 'not-found' | 'folder-link';

export interface ProbeResult {
  target: string;
  verdict: Verdict;
  /** One sentence for a person. */
  summary: string;
  error?: string;
  title?: string;
  username?: string | null;
  chatId?: number;
  type?: 'channel' | 'supergroup' | 'broadcast group' | 'group';
  members?: number | null;
  online?: number | null;
  /** The reader account is already a member. */
  member?: boolean;
  /** Door: things that apply when joining or speaking. */
  door?: {
    joinRequest: boolean;
    joinToSend: boolean;
    /** Only admins are told these two: null = unknown (seen from outside or as a plain member). */
    hiddenHistoryForNewMembers: boolean | null;
    telegramAntispam: boolean | null;
    membersListHidden: boolean;
    slowmodeSeconds: number;
    protectedContent: boolean;
    membersCannot: string[];
    restricted: string[];
  };
  flags?: { verified: boolean; scam: boolean; fake: boolean };
  bots?: string[];
  linkedChatId?: number | null;
  about?: string;
  history?: { readable: boolean; error?: string; sampled: number; newest: number | null; people: number; botMessages: number; perDay: number | null };
  invite?: { requestNeeded: boolean; previewUntil?: number; paid?: boolean };
}

const big = (x: unknown) => Number(String(x));
const channelId = (e: Api.Channel) => -(1_000_000_000_000 + big(e.id));
const on = (o: object, names: string[]) => names.filter((n) => Boolean((o as Record<string, unknown>)[n]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the account can see of a group or channel it has the object of (the probe's details). */
export async function probeChannel(client: TelegramClient, target: string, e: Api.Channel, now: number): Promise<ProbeResult> {
  const r: ProbeResult = {
    target,
    verdict: 'join-needed',
    summary: '',
    title: e.title,
    username: e.username ?? null,
    chatId: channelId(e),
    type: e.broadcast ? 'channel' : e.gigagroup ? 'broadcast group' : 'supergroup',
    members: e.participantsCount ?? null,
    member: !e.left,
    flags: { verified: Boolean(e.verified), scam: Boolean(e.scam), fake: Boolean(e.fake) },
    door: {
      joinRequest: Boolean(e.joinRequest),
      joinToSend: Boolean(e.joinToSend),
      hiddenHistoryForNewMembers: null,
      telegramAntispam: null,
      membersListHidden: false,
      slowmodeSeconds: 0,
      protectedContent: Boolean(e.noforwards),
      membersCannot: e.defaultBannedRights ? on(e.defaultBannedRights, ['viewMessages', 'sendMessages', 'sendMedia', 'embedLinks', 'sendPolls', 'inviteUsers']) : [],
      restricted: (e.restrictionReason ?? []).map((x) => `${x.platform}: ${x.reason}`),
    },
  };

  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: e }));
    const f = full.fullChat as Api.ChannelFull;
    const users = new Map(full.users.map((u) => [String(u.id), u as Api.User]));
    r.members = f.participantsCount ?? r.members;
    r.online = f.onlineCount ?? null;
    const admin = Boolean(e.creator || e.adminRights);
    r.door!.hiddenHistoryForNewMembers = admin ? Boolean(f.hiddenPrehistory) : f.hiddenPrehistory ? true : null;
    r.door!.telegramAntispam = admin ? Boolean(f.antispam) : f.antispam ? true : null;
    r.door!.membersListHidden = Boolean(f.participantsHidden);
    r.door!.slowmodeSeconds = f.slowmodeSeconds ?? 0;
    r.linkedChatId = f.linkedChatId ? -(1_000_000_000_000 + big(f.linkedChatId)) : null;
    r.about = f.about.slice(0, 400);
    r.bots = f.botInfo.map((b) => {
      const u = users.get(String(b.userId));
      return u?.username ? `@${u.username}` : `bot ${String(b.userId)}`;
    });
  } catch {
    // full info can be refused; the rest still says enough
  }
  await sleep(800);

  try {
    const page = (await client.getMessages(e, { limit: 100 })).filter(Boolean);
    const msgs = page.filter((m) => Number.isFinite(m.date)); // deleted ones come back without a date
    const plain = msgs.filter((m) => m instanceof Api.Message) as Api.Message[];
    const people = new Set<string>();
    let botMessages = 0;
    for (const m of plain) {
      const s = m.sender as Api.User | Api.Channel | undefined;
      if (s instanceof Api.User && s.bot) botMessages++;
      else people.add(String(m.senderId));
    }
    // The last week's average, or the rate over the time the 100 cover (not "since the last message
    // before yesterday", which made a quiet group look busy).
    const perDay = msgs.length > 0 ? perDayOf(page, now) : null;
    r.history = { readable: true, sampled: msgs.length, newest: msgs.length ? Math.max(...msgs.map((m) => m.date)) : null, people: people.size, botMessages, perDay };
  } catch (err) {
    r.history = { readable: false, error: explain(err).message, sampled: 0, newest: null, people: 0, botMessages: 0, perDay: null };
  }

  if (r.flags!.scam || r.flags!.fake) {
    r.verdict = 'unsafe';
    r.summary = `Telegram marks this ${r.type} as ${r.flags!.scam ? 'SCAM' : 'FAKE'}. Do not watch it.`;
  } else if (r.history.readable && r.member) {
    r.verdict = 'member';
    r.summary = 'The account is already a member and can read it.';
  } else if (r.history.readable) {
    r.verdict = 'read-from-outside';
    r.summary = `Readable without joining: the account stays out of the member list${r.door!.joinRequest ? ' (joining would need admin approval, and is not needed)' : ''}.`;
  } else if (r.door!.joinRequest) {
    r.verdict = 'request-needed';
    r.summary = 'Not readable from outside, and joining needs an admin to approve a request.';
  } else {
    r.verdict = 'join-needed';
    r.summary = 'Not readable from outside: the account has to join first.';
  }
  return r;
}

export async function probe(client: TelegramClient, target: string, now = Math.floor(Date.now() / 1000)): Promise<ProbeResult> {
  const ref = parseRef(target);
  if (!ref) return { target, verdict: 'not-found', summary: 'Not a @username, t.me link or invite link.' };
  if (ref.kind === 'chatlist') return { target, verdict: 'folder-link', summary: FOLDER_LINK };
  try {
    if (ref.kind === 'invite') {
      // checkChatInvite only reads the invite: it does not join, and the group is not told.
      const inv = await client.invoke(new Api.messages.CheckChatInvite({ hash: ref.hash }));
      if (inv instanceof Api.ChatInviteAlready && inv.chat instanceof Api.Channel) return probeChannel(client, target, inv.chat, now);
      if (inv instanceof Api.ChatInvitePeek && inv.chat instanceof Api.Channel) {
        const r = await probeChannel(client, target, inv.chat, now);
        r.invite = { requestNeeded: false, previewUntil: inv.expires };
        return r;
      }
      if (inv instanceof Api.ChatInvite) {
        const type = inv.broadcast ? 'channel' : inv.megagroup ? 'supergroup' : 'group';
        if (inv.scam || inv.fake) return { target, verdict: 'unsafe', summary: `Telegram marks this ${type} as ${inv.scam ? 'SCAM' : 'FAKE'}.`, title: inv.title, type };
        return {
          target,
          verdict: inv.requestNeeded ? 'request-needed' : 'join-needed',
          summary: inv.requestNeeded
            ? 'Private: joining sends a request that an admin must approve.'
            : 'Private: the account has to join through this link before it can read.',
          title: inv.title,
          type,
          members: inv.participantsCount,
          member: false,
          flags: { verified: Boolean(inv.verified), scam: false, fake: false },
          about: (inv.about ?? '').slice(0, 400),
          invite: { requestNeeded: Boolean(inv.requestNeeded), paid: Boolean(inv.subscriptionPricing) },
        };
      }
      return { target, verdict: 'member', summary: 'The account is already in this chat.' };
    }
    const e = await client.getEntity(ref.value);
    if (!(e instanceof Api.Channel)) {
      return { target, verdict: 'not-found', summary: e instanceof Api.User ? 'That is a person, not a group or channel.' : 'Not a group or channel the account can see.' };
    }
    return await probeChannel(client, target, e, now);
  } catch (err) {
    const e = explain(err);
    return { target, verdict: 'not-found', summary: e.message, error: e.message };
  }
}
