// Restarts the monitor service with a gap of about a second, and never two connections on one
// session: run it in a new terminal tab. It asks the running service to stop (SIGTERM, the same as
// Ctrl-C in its tab), waits until the session is free, then runs the service in this tab. Nothing
// is lost meanwhile: the new service catches up from where the old one stopped.
//
//   caffeinate -is npm run restart

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { loadConfig } from '../src/config.ts';

process.chdir(new URL('..', import.meta.url).pathname);
const here = realpathSync(process.cwd());

// Installed as a LaunchAgent (npm run autostart -- on), launchd runs it and starts it again when it
// stops: let launchd do the restart, or both would start one.
const job = `gui/${userInfo().uid}/com.grouppulse.monitor`;
let managed = false;
try {
  execFileSync('/bin/launchctl', ['print', job], { stdio: 'ignore' });
  managed = true;
} catch {
  // not installed
}
if (managed) {
  execFileSync('/bin/launchctl', ['kickstart', '-k', job], { stdio: 'inherit' });
  console.log(`${new Date().toISOString()} restart: launchd restarted the service (${job}); its log is data/monitor.log`);
  process.exit(0);
}
const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'unused-here' });
const lock = `${config.readerSession}.lock`;
const stamp = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0: only asks whether it exists
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const holder = () => {
  try {
    return Number(readFileSync(lock, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};

// The session is held by whoever wrote the lock: stop it only when that is this monitor's service.
const pid = holder();
if (alive(pid)) {
  let command = '';
  let cwd = '';
  try {
    command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    // Where it runs: the same pid can belong to another program after a reboot or a crash.
    cwd = /^n(.*)$/m.exec(execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }))?.[1] ?? '';
  } catch {
    // gone between the two checks
  }
  const ours = /\bsrc\/main\.ts\b/.test(command) && cwd !== '' && realpathSync(cwd) === here;
  if (command && !ours) {
    console.error(
      `The session lock names process ${pid} (${command}${cwd ? `, in ${cwd}` : ''}), which is not this folder's monitor service. ` +
        `If no monitor is running, the lock is stale: remove ${lock} and run npm start.`,
    );
    process.exit(1);
  }
  // No command line: it exited between the two checks. Signal only a process seen to be the service.
  if (command) {
    console.log(`${stamp()} restart: asking the running service (pid ${pid}) to stop`);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // it stopped by itself
    }
  }
  const deadline = Date.now() + 60_000;
  while (existsSync(lock) && alive(holder()) && Date.now() < deadline) await sleep(100);
  if (existsSync(lock) && alive(holder())) {
    console.error(`${stamp()} restart: it did not stop within a minute; nothing was started.`);
    process.exit(1);
  }
  console.log(`${stamp()} restart: stopped; starting the service here`);
} else {
  console.log(`${stamp()} restart: no service was running; starting it here`);
}

const child = spawn(process.execPath, ['--no-experimental-webstorage', '--env-file-if-exists=.env', 'src/main.ts'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
