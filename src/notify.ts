// macOS notifications for the few moments the owner has to act in the Telegram app (a join
// approved, a check waiting, a removal), for the news radar (a group reacting to the news, or
// talking about it before the first report), and for Claude flagging something (its note stays in
// the console: the notification says only that there is one). Shown with osascript and no shell. What is shown is our
// own fixed text plus, at most, a cleaned group title and (news radar) a cleaned keyword label of
// up to 60 characters, and those reach osascript only as arguments AFTER `--`: without the `--`,
// an argument starting with "-e" is read as one more line of AppleScript (checked on this Mac),
// and a group title is someone else's text.

import { execFile } from 'node:child_process';

export type NoticeKind = 'approved' | 'verifying' | 'removed' | 'paused' | 'test' | 'news' | 'ahead' | 'flag';

export interface Notice {
  kind: NoticeKind;
  /** The group's title (someone else's text), or null when the notice is not about one group. */
  group: string | null;
  /** Our own sentence. Never bot text, button labels, links or invite hashes. */
  body: string;
}

const ZERO_WIDTH_AND_BIDI = /[​-‏‪-‮⁠-⁩﻿]/g;
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFC, controls (newlines too) to spaces, no zero-width or direction marks, at most `max` characters. */
export function clean(s: string, max: number): string {
  const t = s.normalize('NFC').replace(CONTROLS, ' ').replace(ZERO_WIDTH_AND_BIDI, '').replace(/\s+/g, ' ').trim();
  const chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
}

const TITLES: Record<NoticeKind, string> = {
  approved: 'Join approved',
  verifying: 'Verification waiting',
  removed: 'Removed from a group',
  paused: 'Invite checks paused',
  test: 'Group Pulse test',
  news: 'News in your groups',
  ahead: 'A group had it first',
  flag: 'Claude flagged something',
};

/** The osascript arguments: the script is fixed; the title and body come after `--`, as data. */
export function osascriptArgs(n: Notice, opts: { showTitles: boolean }): string[] {
  const who = n.group === null ? '' : opts.showTitles ? `«${clean(n.group, 60)}»: ` : 'A group: ';
  return [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
    '-e',
    'end run',
    '--',
    TITLES[n.kind],
    clean(`${who}${n.body}`, 240),
  ];
}

export interface Notifier {
  notify(n: Notice): void;
}

export const NullNotifier: Notifier = { notify: () => undefined };

type Exec = (file: string, args: string[], opts: { timeout: number }, done: (err: Error | null) => void) => void;

/** Shows notifications one at a time, at least `minGapMs` apart (queued, not dropped). */
export interface MacNotifierOptions {
  enabled: boolean;
  showTitles: boolean;
  platform?: NodeJS.Platform;
  exec?: Exec;
  minGapMs?: number;
  onSent?: (n: Notice) => void;
  onError?: (e: Error) => void;
}

export class MacNotifier implements Notifier {
  private readonly opts: MacNotifierOptions;
  private readonly queue: Notice[] = [];
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;

  constructor(opts: MacNotifierOptions) {
    this.opts = opts;
  }

  notify(n: Notice): void {
    if (!this.opts.enabled || (this.opts.platform ?? process.platform) !== 'darwin') return;
    this.queue.push(n);
    this.pump();
  }

  private pump(): void {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, this.lastAt + (this.opts.minGapMs ?? 15_000) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const n = this.queue.shift();
      if (!n) return;
      this.lastAt = Date.now();
      const exec: Exec = this.opts.exec ?? ((file, args, o, done) => void execFile(file, args, o, (err) => done(err)));
      exec('/usr/bin/osascript', osascriptArgs(n, { showTitles: this.opts.showTitles }), { timeout: 5000 }, (err) => {
        if (!err) return this.opts.onSent?.(n);
        if (this.failed) return; // said once is enough
        this.failed = true;
        this.opts.onError?.(err);
      });
      this.pump();
    }, wait);
    this.timer.unref?.();
  }
}
