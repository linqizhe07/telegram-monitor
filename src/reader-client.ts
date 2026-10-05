// Connects the reader account (GramJS over MTProto) from the session saved by `npm run login`.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Api, TelegramClient } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { classify, describeCall, describeTarget, type Activity } from './activity.ts';
import type { Config } from './config.ts';
import type { MtClient } from './reader.ts';

export function newClient(config: Config, session = ''): TelegramClient {
  return new TelegramClient(new StringSession(session), config.telegramApiId!, config.telegramApiHash, {
    // Keep trying for as long as the network is down (a laptop on Wi-Fi drops it all the time). With a
    // finite number, GramJS gives up after the last attempt and the client stays dead even once the
    // network is back (seen 2026-10-05: 5 attempts 1s apart, then a zombie connection).
    connectionRetries: Infinity,
    retryDelay: 3000,
    autoReconnect: true,
    // Every flood wait surfaces to superviseRequests, which records it and holds the whole account.
    floodSleepThreshold: 0,
    baseLogger: new Logger(LogLevel.ERROR),
    // Telegram's API terms: no "Telegram" in a third-party app's name (2.3).
    deviceModel: 'Group Pulse',
    appVersion: '0.2',
  });
}

/**
 * The one door every request goes through: all GramJS helpers use `invoke`, file downloads use
 * `invokeWithSender`; only the connection handshake and keep-alive pings bypass it (they carry
 * nothing about any chat). At this door each request is
 *  - paced: an account-wide budget of about one request a second (Telegram's limits are not
 *    published; the last public figure was 30 history requests per 30 seconds);
 *  - held while Telegram has asked the account to wait (FLOOD_WAIT), for every chat at once;
 *  - recorded, including every wait (GramJS would otherwise sleep through short waits silently).
 */
export function superviseRequests(
  client: TelegramClient,
  activity: Activity,
  titleOf: (chatId: number) => string | null,
  opts: { intervalMs?: number; burst?: number } = {},
): { pausedUntil: () => number } {
  const interval = opts.intervalMs ?? 1100;
  let tokens = opts.burst ?? 5;
  let refilledAt = Date.now();
  let pausedUntil = 0;
  let queue: Promise<void> = Promise.resolve();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Waits for the account-wide pause and a token, one request at a time. */
  const turn = (): Promise<void> => {
    const mine = queue.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < pausedUntil) {
          await sleep(pausedUntil - now);
          continue;
        }
        tokens = Math.min(opts.burst ?? 5, tokens + (now - refilledAt) / interval);
        refilledAt = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep((1 - tokens) * interval);
      }
    });
    queue = mine.catch(() => undefined);
    return mine;
  };

  const wrap = <A extends unknown[], R>(call: (request: { className: string }, ...rest: A) => Promise<R>) =>
    async (request: { className: string }, ...rest: A): Promise<R> => {
      const req = request as unknown as Record<string, unknown>;
      const kind = classify(request.className, req as { increment?: boolean });
      const target = describeTarget(req, titleOf);
      for (let attempt = 0; ; attempt++) {
        if (kind !== 'system') await turn();
        const started = Date.now();
        try {
          const res = await call(request, ...rest);
          if (kind !== 'system') activity.record({ actor: 'reader', kind, method: request.className, target, detail: describeCall(request.className, req, res), ms: Date.now() - started });
          return res;
        } catch (err) {
          const e = err as { errorMessage?: string; message?: string; seconds?: number };
          const code = e.errorMessage ?? e.message ?? String(err);
          const wait = typeof e.seconds === 'number' ? e.seconds : /FLOOD_WAIT_(\d+)/.test(code) ? Number(/FLOOD_WAIT_(\d+)/.exec(code)![1]) : null;
          if (wait !== null) {
            // Telegram asked this account to slow down: hold every request, not just this one.
            pausedUntil = Math.max(pausedUntil, Date.now() + wait * 1000 * 1.1 + 1000);
            activity.record({ actor: 'reader', kind: 'error', method: request.className, target, detail: `FLOOD_WAIT ${wait}s: Telegram asked the account to slow down; every request now waits until ${new Date(pausedUntil).toISOString()}`, ok: false, ms: Date.now() - started });
            if (wait <= 60 && attempt === 0) continue; // short: wait it out once, then retry
            throw err;
          }
          activity.record({ actor: 'reader', kind, method: request.className, target, detail: code, ok: false, ms: Date.now() - started });
          throw err;
        }
      }
    };
  type Call = (request: { className: string }, ...rest: unknown[]) => Promise<unknown>;
  const c = client as unknown as Record<'invoke' | 'invokeWithSender', Call>;
  c.invoke = wrap(c.invoke.bind(client));
  c.invokeWithSender = wrap(c.invokeWithSender.bind(client));
  return { pausedUntil: () => pausedUntil };
}

/** @deprecated name kept for scripts: same as superviseRequests. */
export const recordRequests = superviseRequests;

export type ConnectionState = 'online' | 'offline';

export interface ReaderConnection {
  client: MtClient;
  /** The GramJS client itself, for requests the reader interface does not cover (probing). */
  raw: TelegramClient;
  name: string;
  id: string;
  disconnect: () => Promise<void>;
  /** Drops the connection and opens a new one (when requests hang). */
  reconnect: () => Promise<void>;
  /** online / offline, and since when (unix seconds). */
  state: () => { state: ConnectionState; since: number };
  /** Until when (ms epoch) Telegram has asked the account to wait; 0 = not waiting. */
  pausedUntil: () => number;
  /** Called when Telegram says the account joined, left or was removed from some chat. */
  onMembershipNotice: (l: () => void) => void;
}

/**
 * Whether an update says the ACCOUNT's own membership changed: a channel or group it is in
 * changed (updateChannel / updateChat: sent on join, leave, removal, and also on some info
 * changes, which is harmless because the check that follows is cheap and rate-limited), or a
 * service message adds or removes the account itself. Other people joining never counts.
 */
export function isMembershipNotice(update: unknown, selfId: string): boolean {
  if (update instanceof Api.UpdateChannel || update instanceof Api.UpdateChat) return true;
  const m = update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage ? update.message : null;
  if (!(m instanceof Api.MessageService)) return false;
  const a = m.action;
  const from = m.fromId instanceof Api.PeerUser ? String(m.fromId.userId) : null;
  if (a instanceof Api.MessageActionChatAddUser) return a.users.some((u) => String(u) === selfId);
  if (a instanceof Api.MessageActionChatDeleteUser) return String(a.userId) === selfId;
  if (a instanceof Api.MessageActionChatJoinedByLink || a instanceof Api.MessageActionChatJoinedByRequest) return from === selfId || Boolean(m.out);
  return false;
}

/** A chat's address saved at watch time, so it is never resolved by name again. */
export interface SavedPeer {
  type: 'channel' | 'chat';
  id: string;
  accessHash?: string;
}

export function inputPeer(p: SavedPeer): unknown {
  return p.type === 'channel'
    ? new Api.InputPeerChannel({ channelId: returnBigInt(p.id), accessHash: returnBigInt(p.accessHash ?? '0') })
    : new Api.InputPeerChat({ chatId: returnBigInt(p.id) });
}

/**
 * One process per session file: the same session used by two connections at once can get it
 * revoked (AUTH_KEY_DUPLICATED). The service and `npm run probe` both take this lock.
 */
export function acquireSessionLock(sessionPath: string): { release: () => void } {
  const file = `${sessionPath}.lock`;
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8').trim());
    let alive = false;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) {
      throw new Error(
        `the reader session is in use by process ${pid} (the monitor service?). Two connections on one session can get it revoked: stop that process first, or use the console (Check) instead.`,
      );
    }
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file);
    } catch {
      // already gone
    }
  };
  process.once('exit', release);
  return { release };
}

/** The connected reader account, or null (with the reason logged) when it is not set up. */
export async function connectReader(
  config: Config,
  log: (line: string) => void,
  opts: { activity?: Activity; titleOf?: (chatId: number) => string | null } = {},
): Promise<ReaderConnection | null> {
  if (!config.telegramApiId || !config.telegramApiHash) return null;
  if (!existsSync(config.readerSession)) {
    log(`reader: no session at ${config.readerSession}; run \`npm run login\` to sign the reader account in`);
    return null;
  }
  const client = newClient(config, readFileSync(config.readerSession, 'utf8').trim());
  // Reopen saved chats without resolving their names again (resolving is the scarcest budget).
  (client as unknown as { inputPeer: (p: SavedPeer) => unknown }).inputPeer = inputPeer;
  const lock = acquireSessionLock(config.readerSession);
  const supervisor = opts.activity ? superviseRequests(client, opts.activity, opts.titleOf ?? (() => null)) : null;
  await client.connect();
  if (!(await client.checkAuthorization())) {
    log('reader: the saved session is no longer valid (logged out or revoked); run `npm run login` again');
    await client.disconnect();
    return null;
  }
  const me = (await client.getMe()) as { username?: string; firstName?: string; lastName?: string; id?: unknown };

  // Connection state, from GramJS's own connected / disconnected notices.
  let current: { state: ConnectionState; since: number } = { state: 'online', since: Math.floor(Date.now() / 1000) };
  let closing = false; // our own shutdown is not a lost connection
  const setState = (state: ConnectionState) => {
    if (closing || state === current.state) return;
    const now = Math.floor(Date.now() / 1000);
    const was = current;
    current = { state, since: now };
    log(`reader: connection ${state === 'online' ? `back after ${now - was.since}s` : 'lost; retrying every 3s'}`);
    opts.activity?.event('reader', state === 'online' ? 'connection back' : 'connection lost', 'Telegram', state === 'online' ? `offline for ${now - was.since}s; catching up` : 'network unreachable or the server stopped answering; retrying', state === 'online');
  };
  const membershipListeners = new Set<() => void>();
  const selfId = String(me.id);
  client.addEventHandler((update: unknown) => {
    if (update instanceof UpdateConnectionState) {
      if (update.state === UpdateConnectionState.connected) setState('online');
      else setState('offline');
      return;
    }
    if (isMembershipNotice(update, selfId)) for (const l of membershipListeners) l();
  });
  let reconnecting: Promise<void> | null = null;
  return {
    client: client as unknown as MtClient,
    raw: client,
    name: me.username ? `@${me.username}` : ([me.firstName, me.lastName].filter(Boolean).join(' ') || String(me.id)),
    id: String(me.id),
    disconnect: async () => {
      closing = true;
      await client.disconnect();
      lock.release();
    },
    pausedUntil: () => supervisor?.pausedUntil() ?? 0,
    onMembershipNotice: (l: () => void) => {
      membershipListeners.add(l);
    },
    reconnect: () => {
      reconnecting ??= (async () => {
        setState('offline');
        opts.activity?.event('reader', 'reconnect', 'Telegram', 'a request hung: dropping the connection and opening a new one', false);
        await client.disconnect().catch(() => undefined);
        await client.connect();
        if (await client.checkAuthorization()) setState('online');
      })().finally(() => {
        reconnecting = null;
      });
      return reconnecting;
    },
    state: () => current,
  };
}
