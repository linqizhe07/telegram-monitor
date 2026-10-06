// Signs the reader account in once and saves its session to PULSE_READER_SESSION.
// Run it yourself in a terminal. Two ways in:
//
//   npm run login              QR code (default): on a phone where the reader account is signed in,
//                              Telegram → Settings → Devices → Link Desktop Device, and scan it.
//   npm run login -- --phone   phone number + the login code Telegram sends to that account.
//
// Either way, a two-step verification password, if the account has one, is typed here without echo.
// It never creates an account: a number with no Telegram account stops with a message.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import QRCode from 'qrcode';
import { loadConfig } from '../src/config.ts';
import { newClient } from '../src/reader-client.ts';

const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'unused-here' });
if (!config.telegramApiId || !config.telegramApiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first: https://my.telegram.org → API development tools (see COOKBOOK.md, step 4).');
  process.exit(1);
}
const usePhone = process.argv.includes('--phone');

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
const ask = (q: string) => rl.question(q);
const askHidden = async (q: string) => {
  process.stdout.write(q);
  muted = true;
  const answer = await rl.question('');
  muted = false;
  process.stdout.write('\n');
  return answer;
};

const NO_ACCOUNT = 'NO_ACCOUNT';
let failures = 0;
const onError = async (err: Error) => {
  if (err.message === NO_ACCOUNT) {
    console.error('\nThis phone number has no Telegram account. Create the account in the Telegram app first, then run this again.');
    return true; // stop: never sign up from here
  }
  const code = (err as Error & { errorMessage?: string }).errorMessage ?? err.message;
  console.error(`  ${code}`);
  // Telegram caps login attempts (about 5 a day per number) and locks out for up to a day:
  // stop at once on limits and bans, and after a second mistake, instead of retrying.
  if (/FLOOD|BANNED|PHONE_NUMBER_INVALID|PHONE_NUMBER_UNOCCUPIED|AUTH_RESTART/.test(code) || ++failures >= 2) {
    console.error('\nStopping. Wait before trying again (Telegram limits login attempts); if it says FLOOD, wait the time it gives.');
    return true;
  }
  return false;
};
const password = (hint?: string) => askHidden(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `);

const qrPng = join(dirname(config.readerSession), 'login-qr.png');
const client = newClient(config);
await client.connect();
console.log('Sign in the READER account (use a dedicated account, not your main one: see COOKBOOK.md).');
try {
  if (usePhone) {
    await client.start({
      phoneNumber: () => ask('Phone number, international format (e.g. +8613812345678): '),
      phoneCode: () => ask('Login code Telegram just sent to that account: '),
      password,
      firstAndLastNames: () => Promise.reject(new Error(NO_ACCOUNT)),
      onError,
    });
  } else if (!(await client.checkAuthorization())) {
    mkdirSync(dirname(qrPng), { recursive: true });
    await client.signInUserWithQrCode(
      { apiId: config.telegramApiId, apiHash: config.telegramApiHash! },
      {
        qrCode: async ({ token, expires }) => {
          const url = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
          const art = await QRCode.toString(url, { type: 'terminal', small: true });
          await QRCode.toFile(qrPng, url, { width: 360, margin: 2 });
          const seconds = Math.max(0, expires - Math.floor(Date.now() / 1000));
          process.stdout.write('\x1b[2J\x1b[H');
          console.log('On a phone where the READER account is signed in:');
          console.log('  Telegram → Settings → Devices → Link Desktop Device, then scan this code.\n');
          console.log(art);
          console.log(`Also saved as ${qrPng}. The code changes every ~30s (this one: ${seconds}s); keep this window open.`);
        },
        password,
        onError,
      },
    );
  }
} finally {
  rmSync(qrPng, { force: true });
}
mkdirSync(dirname(config.readerSession), { recursive: true });
writeFileSync(config.readerSession, String(client.session.save()), { mode: 0o600 });
const me = (await client.getMe()) as { username?: string; firstName?: string };
console.log(`\nSigned in as ${me.username ? `@${me.username}` : (me.firstName ?? 'the account')}.`);
console.log(`Session saved to ${config.readerSession} (mode 600). It is full access to this account: never commit or share it.`);
console.log('On the phone, Telegram may ask "Is this you?" about the new session: confirm it.');
console.log('To revoke it: Telegram → Settings → Devices → "Group Pulse" → Terminate.');
await client.disconnect();
rl.close();
process.exit(0);
