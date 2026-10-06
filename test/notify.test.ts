import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clean, MacNotifier, osascriptArgs } from '../src/notify.ts';

test('a group title reaches osascript only as data after `--`, cleaned', () => {
  const evil = '-edo shell script "touch /tmp/pwned"\n‮gnp.exe​';
  const args = osascriptArgs({ kind: 'verifying', group: evil, body: 'answer it in your Telegram app.' }, { showTitles: true });
  const dash = args.indexOf('--');
  assert.equal(dash, 6, 'the script is fixed and comes first');
  assert.deepEqual(args.slice(0, dash).filter((a) => a !== '-e'), ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', 'end run']);
  assert.ok(args.slice(0, dash).every((a) => !a.includes('touch')), 'nothing from the title is in the script');
  assert.equal(args[dash + 1], 'Verification waiting');
  assert.ok(args[dash + 2].includes('-edo shell script'), 'the title is shown as text');
  assert.ok(!/[\n‮​]/.test(args[dash + 2]), 'no newline, direction or zero-width marks');
  assert.equal([...clean('x'.repeat(100), 60)].length, 60);
  assert.ok(clean('x'.repeat(100), 60).endsWith('…'));
});

test('lock-screen privacy, macOS only, one at a time', async () => {
  const hidden = osascriptArgs({ kind: 'removed', group: 'Alpha VIP', body: 'reading stopped.' }, { showTitles: false });
  assert.equal(hidden[hidden.length - 1], 'A group: reading stopped.');

  const spawned: string[][] = [];
  const exec = (_f: string, a: string[], _o: unknown, done: (e: Error | null) => void) => {
    spawned.push(a);
    done(null);
  };
  new MacNotifier({ enabled: true, showTitles: true, platform: 'linux', exec }).notify({ kind: 'test', group: null, body: 'x' });
  assert.equal(spawned.length, 0, 'nothing outside macOS');

  const sent: number[] = [];
  const n = new MacNotifier({ enabled: true, showTitles: true, platform: 'darwin', exec, minGapMs: 40, onSent: () => sent.push(Date.now()) });
  n.notify({ kind: 'approved', group: 'A', body: 'you are in.' });
  n.notify({ kind: 'verifying', group: 'B', body: 'answer it in your Telegram app.' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(spawned.length, 2, 'queued, not dropped');
  assert.ok(sent[1] - sent[0] >= 35, 'spaced out');
  for (const a of spawned) assert.ok(!a.join(' ').includes('http') && !a.join(' ').includes('t.me/+'), 'never a link or an invite');
});
