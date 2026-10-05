// Connects the reader account (GramJS over MTProto) from the session saved by `npm run login`.

import { existsSync, readFileSync } from 'node:fs';
import { TelegramClient } from 'telegram';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
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

/** The connected reader account, or null (with the reason logged) when it is not set up. */
export async function connectReader(
  config: Config,
  log: (line: string) => void,
): Promise<{ client: MtClient; name: string; disconnect: () => Promise<void> } | null> {
  if (!config.telegramApiId || !config.telegramApiHash) return null;
  if (!existsSync(config.readerSession)) {
    log(`reader: no session at ${config.readerSession}; run \`npm run login\` to sign the reader account in`);
    return null;
  }
  const client = newClient(config, readFileSync(config.readerSession, 'utf8').trim());
  await client.connect();
  if (!(await client.checkAuthorization())) {
    log('reader: the saved session is no longer valid (logged out or revoked); run `npm run login` again');
    await client.disconnect();
    return null;
  }
  const me = (await client.getMe()) as { username?: string; firstName?: string; id?: unknown };
  return {
    client: client as unknown as MtClient,
    name: me.username ? `@${me.username}` : (me.firstName ?? String(me.id)),
    disconnect: () => client.disconnect(),
  };
}
