// The rules of the private-group flow (docs/private-groups.md), with no Telegram connection in
// them: what an invite check answered, what to warn about before joining, the ration of invite
// checks, the check schedules, the account's own standing in a chat, and which bot messages
// address the account. InviteTracker (invites.ts) applies them; the MCP server reads the status
// through formatInviteStatus without loading any Telegram code.

import { chatIdOf, parseRef, peerOf, type MtButton, type MtEntity, type MtMessage } from './reader.ts';
import type { InviteRow, MembershipRow, Store } from './store.ts';
import { localDate, localTime } from './transcript.ts';

export type InviteVerdict = 'member' | 'peek' | 'join' | 'request' | 'paid' | 'refused' | 'dead';
export type InviteState =
  | 'previewed'
  | 'owner-opened'
  | 'requested'
  | 'joined'
  | 'verifying'
  | 'watching'
  | 'removed'
  | 'no-answer'
  | 'link-dead'
  | 'refused'
  | 'dismissed'
  | 'expired';
/** States a row does not leave by itself (a chat-list match can still revive a dead link). */
export const DONE: InviteState[] = ['no-answer', 'link-dead', 'refused', 'dismissed', 'expired'];
export type SelfStateName = 'member' | 'verifying' | 'muted' | 'removed' | 'banned' | 'banned-until' | 'unknown';

export interface InviteFacts {
  verdict: InviteVerdict;
  title: string;
  kind: 'channel' | 'supergroup' | 'group';
  members: number | null;
  about: string;
  verified: boolean;
  scam: boolean;
  fake: boolean;
  requestNeeded: boolean;
  /** The link charges a Telegram Stars subscription. */
  paid: boolean;
  /** "Readable without joining until …" (chatInvitePeek). */
  peekUntil: number | null;
  /** Only when the answer carried the chat itself (already a member, or a preview). */
  chat: { chatId: number; peer: string | null; entity: MtEntity } | null;
}

export interface Warning {
  level: 'stop' | 'caution' | 'info';
  code: string;
  text: string;
  /** Research fact ids (docs/private-groups.md). */
  evidence: string[];
}

export interface SelfState {
  state: SelfStateName;
  until: number | null;
  detail: string;
  viaRequest?: boolean;
  joinedAt?: number;
}

/** A bot message that seems to address the account: shown to the owner, never stored, never sent to Claude. */
export interface ChallengeHint {
  chatId: number;
  msgId: number;
  date: number;
  sender: { id: string; username: string | null; name: string; bot: boolean; viaBot: boolean };
  why: string[];
  text: string;
  /** Labels only; a link shows its host. */
  buttons: string[];
  /**
   * The same buttons, by row and column, and what the console may do with each, on the owner's
   * click only: press it here (a plain callback button), open it in the Telegram app (a t.me link to
   * a bot, a person or a chat), or nothing (pages inside Telegram, logins, phone or location
   * requests, payments, links to sites: those are done in the app). Callback data never leaves the
   * service: the console names a button by its place.
   */
  keys: ChallengeKey[];
  media: string | null;
  /** A photo comes with it (often the check's picture): the console can show it. */
  photo: boolean;
  suspicious: string | null;
  /** What the owner did about it from the console, and when. */
  done?: string;
}

export interface ChallengeKey {
  row: number;
  col: number;
  label: string;
  kind: 'press' | 'telegram' | 'app';
  /** For 'telegram': a tg:// link that opens the bot (with its start parameter) or the chat in the app. */
  open: string | null;
  /** For a link to a site: its host, shown as text, never opened from here. */
  host: string | null;
}

/** A t.me link to a bot, a person or a public chat, as a link the Telegram app opens; null for anything else. */
export function telegramLink(url: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\?start=([A-Za-z0-9_-]{1,64}))?$/i.exec(url.trim());
  return m ? `tg://resolve?domain=${m[1]}${m[2] ? `&start=${m[2]}` : ''}` : null;
}

/** What the console may do with a bot's button (see ChallengeHint.keys). */
export function keyOf(b: MtButton & { requiresPassword?: boolean }, row: number, col: number): ChallengeKey {
  const label = (b.text ?? '').trim().slice(0, 80) || 'button';
  if (b.className === 'KeyboardButtonCallback' && !b.requiresPassword) return { row, col, label, kind: 'press', open: null, host: null };
  if (b.className === 'KeyboardButtonUrl' && b.url) {
    const open = telegramLink(b.url);
    return open ? { row, col, label, kind: 'telegram', open, host: null } : { row, col, label, kind: 'app', open: null, host: hostOf(b.url) };
  }
  return { row, col, label, kind: 'app', open: null, host: null };
}

// ── links ──────────────────────────────────────────────────────────────────

const HASH = /^[A-Za-z0-9_-]{8,64}$/;

/** The invite hash in a t.me/+…, t.me/joinchat/… or tg://join?invite=… link, or null. */
export function inviteHash(input: string): string | null {
  const ref = parseRef(input);
  return ref?.kind === 'invite' && HASH.test(ref.hash) ? ref.hash : null;
}

/** The two ways to open an invite in the official app. Only a validated hash ever goes into a URL. */
export function deepLinks(hash: string): { tme: string; tg: string } {
  if (!HASH.test(hash)) throw new Error('not an invite hash');
  return { tme: `https://t.me/+${hash}`, tg: `tg://join?invite=${hash}` };
}

export const isDeadLink = (code: string): boolean => /INVITE_HASH_(EXPIRED|INVALID|EMPTY)/.test(code);

/** For matching a chat found in the chat list to an invite: NFKC, case-folded, spaces collapsed. */
export const normTitle = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// ── what an invite check answered ──────────────────────────────────────────

/** The answer of messages.checkChatInvite, duck-typed (GramJS objects carry `className`). */
export interface InviteAnswer {
  className: string;
  chat?: MtEntity;
  expires?: number;
  title?: string;
  about?: string;
  participantsCount?: number;
  broadcast?: boolean;
  megagroup?: boolean;
  requestNeeded?: boolean;
  verified?: boolean;
  scam?: boolean;
  fake?: boolean;
  subscriptionPricing?: unknown;
}

const kindOf = (e: { className?: string; broadcast?: boolean; megagroup?: boolean }, isChannel: boolean): InviteFacts['kind'] =>
  isChannel ? (e.broadcast ? 'channel' : 'supergroup') : e.megagroup ? 'supergroup' : 'group';

export function classifyInvite(inv: InviteAnswer): InviteFacts {
  if ((inv.className === 'ChatInviteAlready' || inv.className === 'ChatInvitePeek') && inv.chat) {
    const e = inv.chat;
    const flagged = Boolean(e.scam || e.fake);
    const peek = inv.className === 'ChatInvitePeek';
    return {
      verdict: peek ? (flagged ? 'refused' : 'peek') : 'member',
      title: e.title ?? '',
      kind: kindOf(e, e.className === 'Channel' || e.className === 'ChannelForbidden'),
      members: e.participantsCount ?? null,
      about: '',
      verified: Boolean(e.verified),
      scam: Boolean(e.scam),
      fake: Boolean(e.fake),
      requestNeeded: Boolean(e.joinRequest),
      paid: false,
      peekUntil: peek ? (inv.expires ?? null) : null,
      chat: { chatId: chatIdOf(e), peer: peerOf(e), entity: e },
    };
  }
  if (inv.className === 'ChatInvite') {
    const facts: InviteFacts = {
      verdict: 'join',
      title: inv.title ?? '',
      kind: inv.broadcast ? 'channel' : inv.megagroup ? 'supergroup' : 'group',
      members: inv.participantsCount ?? null,
      about: (inv.about ?? '').slice(0, 400),
      verified: Boolean(inv.verified),
      scam: Boolean(inv.scam),
      fake: Boolean(inv.fake),
      requestNeeded: Boolean(inv.requestNeeded),
      paid: Boolean(inv.subscriptionPricing),
      peekUntil: null,
      chat: null,
    };
    facts.verdict = facts.scam || facts.fake ? 'refused' : facts.paid ? 'paid' : facts.requestNeeded ? 'request' : 'join';
    return facts;
  }
  throw new Error(`unexpected answer to an invite check: ${inv.className}`);
}

// ── warnings shown before joining ──────────────────────────────────────────

/** In the order the console shows them. `at` formats a time for the owner. */
export function warningsFor(f: Pick<InviteFacts, 'verdict' | 'title' | 'scam' | 'fake' | 'peekUntil'>, at: (t: number) => string): Warning[] {
  const w: Warning[] = [];
  const add = (level: Warning['level'], code: string, text: string, evidence: string[]) => w.push({ level, code, text, evidence });
  if (f.verdict === 'refused') {
    add('stop', 'scam-flag', `Telegram marks this group as ${f.scam ? 'SCAM' : 'FAKE'}. It is not offered: no links are shown.`, ['M-05']);
    return w;
  }
  if (f.verdict === 'dead') {
    add('stop', 'dead', 'This invite link no longer works (expired or revoked).', []);
    return w;
  }
  if (f.verdict === 'member') {
    add('info', 'member', 'This account is already in this group.', ['M-07']);
    return w;
  }
  if (f.verdict === 'paid') {
    add('stop', 'paid', 'This link charges a Telegram Stars subscription to join. This service never pays. Paying is your decision, made in your Telegram app.', ['CB-m07', 'M-09']);
  }
  if (f.verdict === 'peek' && f.peekUntil) {
    add(
      'info',
      'peek',
      `Readable without joining until ${at(f.peekUntil)}. Telegram offers this time-limited preview for some links. It is not a way to keep reading: to follow the group, join in your Telegram app.`,
      ['M-07', 'CB-m01', 'AL-29'],
    );
  }
  if (f.verdict === 'request') {
    add(
      'caution',
      'request',
      'Joining sends a request that an admin or a bot must approve. Telegram has no way to withdraw it, approval can take minutes or days, and you are not told about a decline. A bot may message you about the request within 5 minutes. An admin who chats with you sees your account\'s registration month and phone country.',
      ['M-10', 'CB-03', 'M-32', 'CB-04', 'CB-m12', 'M-m15'],
    );
    add(
      'caution',
      'guard-miniapp',
      'Groups that approve requests may show a bot page (a Mini App) inside the join itself. Finish it in your Telegram app. This service never opens verification pages.',
      ['CB-05', 'CB-06', 'GM-01', 'GM-04', 'GM-14'],
    );
  }
  add(
    'caution',
    'visible',
    'This is your own Telegram account. When you join, members and admins see it: you appear in the member list, a «joined» line may appear in the chat, and the admin log records which invite link you used. Your name, photo and @username are visible to them.',
    ['AL-28', 'M-31'],
  );
  add(
    'caution',
    'guard-unknown',
    'Nothing visible before joining tells whether this group screens newcomers with a bot. If there is a check, it appears in your Telegram app right after you join (or after approval). Answer it there.',
    ['CB-m06', 'M-m02', 'M-06', 'CB-39'],
  );
  add(
    'caution',
    'windows',
    'Some checks give very little time: as little as 10 seconds with Join Captcha Bot, 60 seconds by default with Shieldy. Join when you can answer at once. A missed or failed check usually removes you, and repeated failed joins can end in a permanent ban.',
    ['CB-20', 'CB-16', 'CB-18', 'CB-m03'],
  );
  add(
    'caution',
    'scam-portal',
    'Real checks never ask for your login code, password or phone number, a wallet connection or signature, or for you to paste or run anything on your computer. A «verify» bot that asks for any of these is a scam. Check the bot\'s exact @username.',
    ['CB-33', 'M-25'],
  );
  if (/binance|币安|幣安/i.test(f.title)) {
    add(
      'caution',
      'brand',
      'Binance\'s official groups are public and can be read without joining. A private «Binance» group reached by invite is not on Binance\'s official list, and Telegram\'s verified badge does not prove a group is official.',
      ['BN-01', 'BN-08', 'BN-05', 'BN-16', 'BN-m01'],
    );
  }
  add('caution', 'ai-terms', 'Messages from this group will be summarised by Claude. Telegram\'s terms restrict using chat content to deploy AI without each member\'s consent. Whether to accept that is your decision.', ['M-29', 'AL-22']);
  add(
    'info',
    'filters',
    'Some groups remove newcomers with no check at all. Causes include the CAS ban list (also applied after the fact), rules on account id, name script, a missing @username or photo, and anti-raid mode.',
    ['CB-29', 'PF-17', 'PF-18', 'PF-19', 'CB-19', 'PF-08', 'PF-24', 'CB-26'],
  );
  add(
    'info',
    'purge',
    'Silent members can be removed later, for example by an inactivity clean-up after days or weeks. Reading never counts as activity. If that happens, this page shows it and stops reading the group.',
    ['SP-01', 'SP-04', 'SP-05', 'SP-11'],
  );
  add('info', 'hidden-history', 'Private groups can hide earlier messages from new members, and that is only known after joining. If so, the digest starts at your join.', ['M-02', 'M-03', 'M-06']);
  add('info', 'spread', 'A ban in one group can follow you: CAS bans and federation bans apply across many groups.', ['CB-m10', 'CB-29']);
  add(
    'info',
    'unofficial-flag',
    'Telegram may label accounts that use unofficial apps on their profile. Whether this service\'s session causes that is not known yet. Admins who open your profile could see it.',
    ['UF-01', 'UF-02', 'UF-09'],
  );
  return w;
}

// ── the ration of invite checks ────────────────────────────────────────────

export type Lane = 'owner' | 'background' | 'mcp';

export interface BudgetLimits {
  perDay: number;
  backgroundPerDay: number;
  mcpPerDay: number;
  /** Seconds between any two checks. */
  minGap: number;
  /** Seconds before a background check, after any check. */
  backgroundGap: number;
  /** Seconds a preview of the same link is reused without asking Telegram again. */
  cache: number;
}

/**
 * Telegram publishes no limit for invite checks; GramJS's own docs say they are limited like
 * username lookups, whose best public figure is about 200 a day. These are a tenth of that, and
 * this is the owner's main account (docs/private-groups.md, section 5.2).
 */
export const BUDGET: BudgetLimits = { perDay: 20, backgroundPerDay: 12, mcpPerDay: 5, minGap: 30, backgroundGap: 120, cache: 600 };

interface BudgetState {
  at: [number, Lane][];
  frozenUntil: number;
  floods: number[];
}

export class InviteBudget {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly limits: BudgetLimits;

  constructor(store: Store, now: () => number, limits: BudgetLimits = BUDGET) {
    this.store = store;
    this.now = now;
    this.limits = limits;
  }

  private load(): BudgetState {
    try {
      const s = JSON.parse(this.store.getKv('invite_budget') ?? '') as BudgetState;
      if (Array.isArray(s.at) && Array.isArray(s.floods)) return s;
    } catch {
      // first use
    }
    return { at: [], frozenUntil: 0, floods: [] };
  }

  private save(s: BudgetState): void {
    this.store.setKv('invite_budget', JSON.stringify(s));
  }

  /** Spends one check from `lane`, or says when the next one is possible. */
  take(lane: Lane): { ok: true } | { ok: false; reason: string; retryAt: number } {
    const s = this.load();
    const now = this.now();
    const L = this.limits;
    s.at = s.at.filter(([t]) => t > now - 86_400);
    if (s.frozenUntil > now) return { ok: false, reason: 'paused: Telegram asked the account to slow down', retryAt: s.frozenUntil };
    const of = (l?: Lane) => s.at.filter(([, x]) => !l || x === l).map(([t]) => t);
    if (of().length >= L.perDay) return { ok: false, reason: `${L.perDay} invite checks in 24 hours`, retryAt: Math.min(...of()) + 86_400 };
    if (lane === 'background' && of('background').length >= L.backgroundPerDay) {
      return { ok: false, reason: `${L.backgroundPerDay} scheduled invite checks in 24 hours`, retryAt: Math.min(...of('background')) + 86_400 };
    }
    if (lane === 'mcp' && of('mcp').length >= L.mcpPerDay) {
      return { ok: false, reason: `${L.mcpPerDay} invite checks from Claude in 24 hours (check it in the console instead)`, retryAt: Math.min(...of('mcp')) + 86_400 };
    }
    const last = Math.max(0, ...of());
    const gap = lane === 'background' ? L.backgroundGap : L.minGap;
    if (now - last < gap) return { ok: false, reason: 'invite checks are spaced out', retryAt: last + gap };
    s.at.push([now, lane]);
    this.save(s);
    return { ok: true };
  }

  /** Telegram asked the account to wait during an invite check: no more of them for a while. */
  flood(seconds: number): number {
    const s = this.load();
    const now = this.now();
    s.floods = s.floods.filter((t) => t > now - 86_400);
    const freeze = s.floods.length > 0 ? 86_400 : Math.max(2 * seconds, 6 * 3600);
    s.floods.push(now);
    s.frozenUntil = Math.max(s.frozenUntil, now + freeze);
    this.save(s);
    return s.frozenUntil;
  }

  view(): { used24h: number; background24h: number; mcp24h: number; perDay: number; frozenUntil: number | null } {
    const s = this.load();
    const now = this.now();
    const recent = s.at.filter(([t]) => t > now - 86_400);
    return {
      used24h: recent.length,
      background24h: recent.filter(([, l]) => l === 'background').length,
      mcp24h: recent.filter(([, l]) => l === 'mcp').length,
      perDay: this.limits.perDay,
      frozenUntil: s.frozenUntil > now ? s.frozenUntil : null,
    };
  }
}

// ── schedules ──────────────────────────────────────────────────────────────

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

/**
 * A pending join request: checked when the owner says it was sent, then after 1 hour, 6 hours, 1
 * day, and daily until day 14 (17 checks at most). The requester is never told about approval;
 * only membership shows it (and a membership notice usually brings it much sooner).
 */
const PENDING = [0, HOUR, 6 * HOUR, DAY, ...Array.from({ length: 13 }, (_, i) => (i + 2) * DAY)];
export function pendingSchedule(saidAt: number, checksDone: number): number | null {
  return checksDone < PENDING.length ? saidAt + PENDING[checksDone] : null;
}
export const PENDING_CHECKS = PENDING.length;

/** While a check is waiting: 1, 3, 10, 30 minutes, 1, 3, 8, 24 hours, then daily up to 7 days. */
const VERIFY = [MIN, 3 * MIN, 10 * MIN, 30 * MIN, HOUR, 3 * HOUR, 8 * HOUR, DAY, ...Array.from({ length: 6 }, (_, i) => (i + 2) * DAY)];
export function verifySchedule(joinedAt: number, checksDone: number): number | null {
  return checksDone < VERIFY.length ? joinedAt + VERIFY[checksDone] : null;
}

/** How long after a join a bot message addressed to the account counts as a check (no mute needed). */
export const HINT_WINDOW = 15 * MIN;

// ── the account's own standing in a chat ───────────────────────────────────

interface Rights {
  viewMessages?: boolean;
  sendMessages?: boolean;
  sendMedia?: boolean;
  sendPlain?: boolean;
  untilDate?: number;
}
export interface ChatShape {
  className: string;
  left?: boolean;
  deactivated?: boolean;
  untilDate?: number;
  bannedRights?: Rights;
  defaultBannedRights?: Rights;
}
export interface ParticipantShape {
  className: string;
  viaRequest?: boolean;
  date?: number;
  left?: boolean;
  bannedRights?: Rights;
}

/**
 * Member, held for a check, removed or banned: from the chat object first (the account's own
 * restrictions are reliable there, next to the group's defaults), else from its participant
 * entry, else from the error. A restriction counts only if it is the account's own, not one every
 * member has. A media-only restriction is not a check by itself (some bots limit media for a day).
 */
export function classifySelf(i: { chat?: ChatShape; participant?: ParticipantShape; error?: string }, now: number): SelfState {
  const YEAR = 366 * DAY;
  const timed = (until: number | undefined) => Boolean(until && until > now && until - now <= YEAR);
  const c = i.chat;
  if (c && (c.className === 'ChannelForbidden' || c.className === 'ChatForbidden')) {
    return timed(c.untilDate)
      ? { state: 'banned-until', until: c.untilDate!, detail: 'removed by the group until this time (a kick or a timed ban)' }
      : { state: 'banned', until: null, detail: 'banned from the group (or removed with no end date)' };
  }
  if (c && c.className === 'Channel') {
    if (c.left) return { state: 'removed', until: null, detail: 'not a member any more (left or removed)' };
    const own = c.bannedRights;
    const group = c.defaultBannedRights;
    const live = Boolean(own && (!own.untilDate || own.untilDate > now));
    const personal = (k: keyof Omit<Rights, 'untilDate'>) => live && Boolean(own?.[k]) && !group?.[k];
    if (personal('viewMessages')) return { state: 'banned', until: own!.untilDate || null, detail: 'banned' };
    if (personal('sendMessages') || personal('sendPlain')) {
      return { state: 'verifying', until: own!.untilDate || null, detail: 'cannot send messages there yet (often until a check is passed)' };
    }
    return { state: 'member', until: null, detail: personal('sendMedia') ? 'media restricted (reading works)' : '' };
  }
  if (c && c.className === 'Chat') {
    return c.left || c.deactivated
      ? { state: 'removed', until: null, detail: c.deactivated ? 'upgraded to a supergroup' : 'not a member any more' }
      : { state: 'member', until: null, detail: '' };
  }
  const p = i.participant;
  if (p) {
    if (p.className === 'ChannelParticipantLeft') return { state: 'removed', until: null, detail: 'not a member any more' };
    if (p.className === 'ChannelParticipantBanned') {
      const r = p.bannedRights ?? {};
      if (p.left || r.viewMessages) {
        return timed(r.untilDate)
          ? { state: 'banned-until', until: r.untilDate!, detail: 'removed by the group until this time' }
          : { state: 'banned', until: null, detail: 'banned' };
      }
      return { state: 'verifying', until: r.untilDate || null, detail: 'restricted in this group' };
    }
    return { state: 'member', until: null, detail: '', viaRequest: Boolean(p.viaRequest), joinedAt: p.date };
  }
  if (i.error && /USER_NOT_PARTICIPANT/.test(i.error)) return { state: 'removed', until: null, detail: 'not a member' };
  if (i.error && /CHANNEL_PRIVATE|CHAT_FORBIDDEN/.test(i.error)) return { state: 'removed', until: null, detail: 'removed (left, kicked or banned)' };
  return { state: 'unknown', until: null, detail: i.error ?? 'no answer' };
}

// ── bot messages that address the account ──────────────────────────────────

/** What is commonly known about the big check bots (by exact username), for the banner. */
export const BOT_PRIORS: Record<string, string> = {
  shieldy_bot: 'usually about 60 s after joining (Shieldy\'s default; admins can change it)',
  join_captcha_bot: '5 minutes by default; 10 s to 10 min possible',
  missrose_bot: 'muted until solved; some groups remove you after 5 min to 1 day',
  combot: 'page checks allow 12 hours',
};

const asText = (data: Uint8Array | undefined): string => (data ? Buffer.from(data).toString('latin1') : '');

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'a link';
  } catch {
    return 'a link';
  }
}

/**
 * Whether a message in a just-joined chat seems to be a check addressed to this account. The
 * sender must be a bot (or the message posted "via" an inline bot, which is flagged: a person can
 * do that, so it is not a real check). Signals, strongest first: a button's data carries the
 * account's id; a mention of the account; Telegram's own "mentioned" flag; the @username in the
 * text. Button data is only tested, never shown, stored or used to choose anything.
 */
export function matchChallenge(m: MtMessage, self: { id: string; username: string | null }, joinedAt: number, chatId: number): ChallengeHint | null {
  const s = m.sender;
  const bot = Boolean(s && s.className === 'User' && s.bot);
  const viaBot = m.viaBotId !== undefined && m.viaBotId !== null;
  if (!bot && !viaBot) return null;
  if (m.date < joinedAt - 60) return null;
  const why: string[] = [];
  const digits = self.id.replace(/\D/g, '');
  const idToken = new RegExp(`(^|[^0-9])${digits}($|[^0-9])`);
  const buttons = (m.replyMarkup?.rows ?? []).flatMap((r) => r.buttons ?? []);
  if (digits && buttons.some((b) => idToken.test(asText(b.data)))) why.push('a button carries your account id');
  if ((m.entities ?? []).some((e) => e.className === 'MessageEntityMentionName' && String(e.userId) === self.id)) why.push('it mentions you');
  if (m.mentioned) why.push('Telegram marks it as mentioning you');
  const name = (self.username ?? '').replace(/[^A-Za-z0-9_]/g, '');
  if (name && new RegExp(`@${name}(?![A-Za-z0-9_])`, 'i').test(m.message ?? '')) why.push('it names your @username');
  if (why.length === 0) return null;
  const photo = m.media?.className === 'MessageMediaPhoto';
  const media = m.media
    ? photo
      ? '[photo]'
      : m.media.className === 'MessageMediaDocument'
        ? '[video or file]: see it in your Telegram app'
        : m.media.className === 'MessageMediaWebPage'
          ? null
          : '[media]: see it in your Telegram app'
    : null;
  return {
    chatId,
    msgId: m.id,
    date: m.date,
    sender: {
      id: s ? String(s.id) : String(m.viaBotId ?? ''),
      username: s?.username ?? null,
      name: [s?.firstName, s?.lastName].filter(Boolean).join(' ') || s?.username || 'a bot',
      bot,
      viaBot,
    },
    why,
    text: (m.message ?? '').slice(0, 500),
    buttons: buttons.map((b) => (b.url ? `${b.text ?? ''} (link to ${hostOf(b.url)}, not opened here)` : (b.text ?? '')).trim()).filter(Boolean).slice(0, 12),
    keys: (m.replyMarkup?.rows ?? []).flatMap((r, row) => (r.buttons ?? []).map((b, col) => keyOf(b, row, col))).slice(0, 24),
    media,
    photo,
    suspicious: viaBot && !bot ? 'posted by a person through an inline bot, not by a group bot: not a real check' : null,
  };
}

// ── views: the console, Claude ─────────────────────────────────────────────

export interface InviteView {
  id: number;
  state: string;
  verdict: string;
  title: string;
  kind: string;
  members: number | null;
  about: string;
  flags: { verified: boolean; scam: boolean; fake: boolean; paid: boolean; requestNeeded: boolean };
  peekUntil: number | null;
  /** The first 4 characters of the hash: enough to tell links apart, never enough to use one. */
  hashTail: string;
  links: { tme: string; tg: string } | null;
  warnings: Warning[];
  said: 'joined' | 'requested' | null;
  saidAt: number | null;
  openedAt: number | null;
  chatId: number | null;
  joinedAt: number | null;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  checks: number;
  note: string;
  createdAt: number;
}

function defaultNote(r: InviteRow, at: (t: number) => string): string {
  switch (r.state) {
    case 'previewed':
      return r.verdict === 'member'
        ? 'The account is already in this group: press «Read it» to follow it.'
        : r.verdict === 'request'
          ? 'Send the join request in your Telegram app, then press «I\'ve sent a request».'
          : r.verdict === 'paid'
            ? 'Paid link: this service never pays. If you pay and join in your Telegram app, press «I\'ve joined».'
            : 'Join it in your Telegram app, then press «I\'ve joined». This page never joins.';
    case 'owner-opened':
      return `Opened in Telegram${r.openedAt ? ` at ${at(r.openedAt)}` : ''}. When you are in, or have sent the request, press the button.`;
    case 'requested':
      return `Request tracked: ${r.nextCheckAt ? `next check ${at(r.nextCheckAt)}` : 'checking'} (${r.checks} of ${PENDING_CHECKS} checks done). Telegram never tells the requester about approval or a decline.`;
    case 'joined':
      return 'In: checking your standing there.';
    case 'verifying':
      return 'A check may be waiting in your Telegram app: answer it there.';
    case 'watching':
      return `In${r.joinedAt ? ` since ${at(r.joinedAt)}` : ''}: reading it.`;
    case 'removed':
      return 'No longer a member: reading stopped. Rejoining is your decision, in your Telegram app.';
    case 'no-answer':
      return 'No approval in 14 days. Telegram never reports a decline.';
    case 'link-dead':
      return 'This link no longer works. If you did join, the group appears under Sources by itself.';
    case 'refused':
      return 'Telegram marks this group as scam or fake: not offered.';
    case 'dismissed':
      return 'Not tracked any more.';
    case 'expired':
      return 'Expired: nothing happened for 7 days.';
  }
  return '';
}

export function inviteView(r: InviteRow, at: (t: number) => string, withLinks: boolean): InviteView {
  const flags = {
    verified: r.flags.includes('verified'),
    scam: r.flags.includes('scam'),
    fake: r.flags.includes('fake'),
    paid: r.flags.includes('paid'),
    requestNeeded: r.flags.includes('request'),
  };
  const linkable = withLinks && r.hash && !['refused', 'dead'].includes(r.verdict) && !['refused', 'dismissed', 'expired'].includes(r.state);
  return {
    id: r.id,
    state: r.state,
    verdict: r.verdict,
    title: r.title,
    kind: r.kind,
    members: r.members,
    about: r.about,
    flags,
    peekUntil: r.peekUntil,
    hashTail: r.hash ? `${r.hash.slice(0, 4)}…` : '',
    links: linkable ? deepLinks(r.hash!) : null,
    warnings: warningsFor({ verdict: r.verdict as InviteVerdict, title: r.title, scam: flags.scam, fake: flags.fake, peekUntil: r.peekUntil }, at),
    said: r.said,
    saidAt: r.saidAt,
    openedAt: r.openedAt,
    chatId: r.chatId,
    joinedAt: r.joinedAt,
    lastCheckAt: r.lastCheckAt,
    nextCheckAt: r.nextCheckAt,
    checks: r.checks,
    note: r.note || defaultNote(r, at),
    createdAt: r.createdAt,
  };
}

/**
 * The status Claude may see (MCP invite_status): states, times, the first 4 characters of each
 * hash. Never a check's text, its buttons, or a full invite hash.
 */
export function formatInviteStatus(
  invites: InviteRow[],
  memberships: (MembershipRow & { title: string })[],
  budget: { used24h: number; perDay: number; frozenUntil: number | null },
  now: number,
  tz: string,
): string {
  const at = (t: number) => (localDate(t, tz) === localDate(now, tz) ? localTime(t, tz) : `${localDate(t, tz)} ${localTime(t, tz)}`);
  const age = (t: number) => {
    const s = Math.max(0, now - t);
    return s < 3600 ? `${Math.round(s / 60)} min ago` : s < DAY ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / DAY)} d ago`;
  };
  const out: string[] = [];
  out.push(invites.length ? 'Invite links:' : 'No invite links are being followed.');
  for (const r of invites) {
    const parts = [`«${r.title || 'untitled'}» (invite ${r.hash ? `${r.hash.slice(0, 4)}…` : 'forgotten'})`, r.state, `added ${age(r.createdAt)}`];
    if (r.lastCheckAt) parts.push(`last checked ${at(r.lastCheckAt)}`);
    if (r.nextCheckAt && !DONE.includes(r.state as InviteState)) parts.push(`next check ${at(r.nextCheckAt)}`);
    out.push(`- ${parts.join(' · ')}`);
  }
  out.push('', memberships.length ? 'Standing in joined groups:' : 'No joined group is being watched for checks or removals.');
  for (const m of memberships) {
    if (m.state === 'verifying') {
      out.push(`- «${m.title}»: a check may be waiting (since ${at(m.joinedAt ?? m.checkedAt)}). Answer it in your Telegram app. I can't see or answer it.`);
      continue;
    }
    const parts = [`«${m.title}»`, m.state];
    if (m.untilDate) parts.push(`until ${at(m.untilDate)}`);
    if (m.joinedAt) parts.push(`joined ${at(m.joinedAt)}${m.viaRequest ? ' (via request)' : ''}`);
    if (m.historyFrom) parts.push(`history from message #${m.historyFrom}`);
    if (m.detail) parts.push(m.detail);
    out.push(`- ${parts.join(' · ')}`);
  }
  out.push('', `Invite checks in the last 24 hours: ${budget.used24h} of ${budget.perDay}${budget.frozenUntil ? `; paused until ${at(budget.frozenUntil)} (Telegram asked the account to slow down)` : ''}.`);
  out.push('Joining happens only in the owner\'s Telegram app; the console\'s «I\'ve joined» button is how the service learns of it. Claude cannot join, confirm or answer checks.');
  return out.join('\n');
}
