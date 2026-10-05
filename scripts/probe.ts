// Read-only look at groups and channels before anything is joined (see src/probe.ts).
//
//   npm run probe -- @BinanceChinese https://t.me/+inviteHash ...

import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { probe } from '../src/probe.ts';
import { newClient } from '../src/reader-client.ts';

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (targets.length === 0) {
  console.error('usage: npm run probe -- <@username | t.me link | invite link> ...');
  process.exit(1);
}
const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'unused-here' });
const client = newClient(config, readFileSync(config.readerSession, 'utf8').trim());
await client.connect();
if (!(await client.checkAuthorization())) {
  console.error('The reader session is not valid: run `npm run login`.');
  process.exit(1);
}
for (const [i, t] of targets.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000)); // resolving names is rate-limited
  console.log(`\n── ${t}\n${JSON.stringify(await probe(client, t), null, 2)}`);
}
await client.disconnect();
process.exit(0);
