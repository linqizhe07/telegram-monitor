// Signs the reader account in once and saves its session to PULSE_READER_SESSION.
// Run it yourself in a terminal: it asks for the phone number, the login code Telegram sends to
// that account, and the two-step verification password if one is set (typed without echo).
//
//   npm run login

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadConfig } from '../src/config.ts';
import { newClient } from '../src/reader-client.ts';

const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'unused-here' });
if (!config.telegramApiId || !config.telegramApiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first: https://my.telegram.org → API development tools (see COOKBOOK.md, step 4).');
  process.exit(1);
}

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

const client = newClient(config);
console.log('Sign in the READER account (use a dedicated account, not your main one: see COOKBOOK.md).');
await client.start({
  phoneNumber: () => ask('Phone number, international format (e.g. +8613812345678): '),
  phoneCode: () => ask('Login code Telegram just sent to that account: '),
  password: (hint) => askHidden(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `),
  onError: (err) => console.error(`  ${err.message}`),
});
mkdirSync(dirname(config.readerSession), { recursive: true });
writeFileSync(config.readerSession, String(client.session.save()), { mode: 0o600 });
const me = (await client.getMe()) as { username?: string; firstName?: string };
console.log(`\nSigned in as ${me.username ? `@${me.username}` : (me.firstName ?? 'the account')}.`);
console.log(`Session saved to ${config.readerSession} (mode 600). It is full access to this account: never commit or share it.`);
console.log('To revoke it: Telegram → Settings → Devices → "Telegram Monitor" → Terminate.');
await client.disconnect();
rl.close();
process.exit(0);
