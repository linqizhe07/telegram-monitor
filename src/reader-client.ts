// Connects the reader account (GramJS over MTProto) from the session saved by `npm run login`.

import { existsSync, readFileSync } from 'node:fs';
import { TelegramClient } from 'telegram';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { classify, describeCall, describeTarget, type Activity } from './activity.ts';
import type { Config } from './config.ts';
import type { MtClient } from './reader.ts';

export function newClient(config: Config, session = ''): TelegramClient {
  return new TelegramClient(new StringSession(session), config.telegramApiId!, config.telegramApiHash, {
    connectionRetries: 5,
    // Short flood waits are slept through by the library; longer ones surface to the reader loop.
    floodSleepThreshold: 60,
    baseLogger: new Logger(LogLevel.ERROR),
    deviceModel: 'Telegram Monitor',
    appVersion: '0.1',
  });
}

/**
 * Records every request the account sends. All GramJS helpers go through `invoke`, and file
 * downloads through `invokeWithSender`; only the connection handshake and keep-alive pings do not
 * (they carry nothing about any chat).
 */
export function recordRequests(client: TelegramClient, activity: Activity, titleOf: (chatId: number) => string | null): void {
  const wrap = <A extends unknown[], R>(call: (request: { className: string }, ...rest: A) => Promise<R>) =>
    async (request: { className: string }, ...rest: A): Promise<R> => {
      const started = Date.now();
      const req = request as unknown as Record<string, unknown>;
      const kind = classify(request.className, req as { increment?: boolean });
      const target = describeTarget(req, titleOf);
      try {
        const res = await call(request, ...rest);
        if (kind !== 'system') activity.record({ actor: 'reader', kind, method: request.className, target, detail: describeCall(request.className, req, res), ms: Date.now() - started });
        return res;
      } catch (err) {
        const e = err as { errorMessage?: string; message?: string };
        activity.record({ actor: 'reader', kind, method: request.className, target, detail: e.errorMessage ?? e.message ?? String(err), ok: false, ms: Date.now() - started });
        throw err;
      }
    };
  type Call = (request: { className: string }, ...rest: unknown[]) => Promise<unknown>;
  const c = client as unknown as Record<'invoke' | 'invokeWithSender', Call>;
  c.invoke = wrap(c.invoke.bind(client));
  c.invokeWithSender = wrap(c.invokeWithSender.bind(client));
}

export interface ReaderConnection {
  client: MtClient;
  /** The GramJS client itself, for requests the reader interface does not cover (probing). */
  raw: TelegramClient;
  name: string;
  id: string;
  disconnect: () => Promise<void>;
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
  if (opts.activity) recordRequests(client, opts.activity, opts.titleOf ?? (() => null));
  await client.connect();
  if (!(await client.checkAuthorization())) {
    log('reader: the saved session is no longer valid (logged out or revoked); run `npm run login` again');
    await client.disconnect();
    return null;
  }
  const me = (await client.getMe()) as { username?: string; firstName?: string; lastName?: string; id?: unknown };
  return {
    client: client as unknown as MtClient,
    raw: client,
    name: me.username ? `@${me.username}` : ([me.firstName, me.lastName].filter(Boolean).join(' ') || String(me.id)),
    id: String(me.id),
    disconnect: () => client.disconnect(),
  };
}
