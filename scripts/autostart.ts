// Keeps the monitor running on this Mac without a terminal window: a launchd agent starts it when
// you log in and starts it again if it ever exits, so whenever the Mac is on and online it catches
// up on everything posted while it was not. It runs under caffeinate (no idle sleep; no system
// sleep on power). Logs go to data/monitor.log.
//
//   npm run autostart -- on       install and start
//   npm run autostart -- off      stop and uninstall
//   npm run autostart -- status   is it installed, is it running
//   npm run autostart -- print    show the launchd definition without installing it

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const LABEL = 'com.grouppulse.monitor';
const root = resolve(new URL('..', import.meta.url).pathname);
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${userInfo().uid}`;
// The stable link, not the versioned path a Node upgrade would remove.
const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? process.execPath;

/** The pid holding the reader session, if that process is alive. */
function sessionHolder(): number | null {
  const file = join(root, 'data', 'reader.session.lock');
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

const launchctl = (...args: string[]) => {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? err) };
  }
};

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function definition(): string {
  const args = ['/usr/bin/caffeinate', '-is', node, '--no-experimental-webstorage', '--env-file-if-exists=.env', 'src/main.ts'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(root, 'data', 'monitor.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(root, 'data', 'monitor.log'))}</string>
</dict>
</plist>
`;
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'print') {
  process.stdout.write(definition());
} else if (cmd === 'on') {
  const holder = sessionHolder();
  if (holder) {
    console.error(`The monitor is already running (process ${holder}). Stop it first (Ctrl-C in its terminal), then run this again.`);
    process.exit(1);
  }
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  launchctl('bootout', `${domain}/${LABEL}`); // replace an older definition, if any
  writeFileSync(plist, definition());
  const r = launchctl('bootstrap', domain, plist);
  if (!r.ok) {
    console.error(`launchctl bootstrap failed: ${r.out}`);
    process.exit(1);
  }
  console.log(`Installed ${plist}`);
  console.log('The monitor now starts when you log in and restarts if it exits. Console: http://127.0.0.1:4830 · log: data/monitor.log');
} else if (cmd === 'off') {
  launchctl('bootout', `${domain}/${LABEL}`);
  rmSync(plist, { force: true });
  console.log('Stopped and uninstalled. Start it by hand with `npm start` when you want it.');
} else {
  const r = launchctl('print', `${domain}/${LABEL}`);
  if (!existsSync(plist)) console.log('Not installed (npm run autostart -- on).');
  else if (!r.ok) console.log(`Installed (${plist}) but not loaded.`);
  else {
    const state = /state = (\w+)/.exec(r.out)?.[1] ?? '?';
    const pid = /pid = (\d+)/.exec(r.out)?.[1];
    console.log(`Installed and ${state}${pid ? ` (pid ${pid})` : ''}. Log: data/monitor.log`);
  }
}
