export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Lang = 'auto' | 'en' | 'zh';
export type RsiMode = 'auto' | 'propose' | 'off';

export interface Config {
  telegramToken: string;
  /** Claude model for every call (digest, editor, judge, improver). */
  model: string;
  digestEffort: Effort;
  rsiEffort: Effort;
  dbPath: string;
  /** Defaults for a newly joined group; each group can change them with /settings. */
  timezone: string;
  digestHour: number;
  language: Lang;
  rsiMode: RsiMode;
  retentionDays: number;
  /** Candidates the improver proposes per generation. */
  rsiCandidates: number;
  /** Recent daily windows each candidate is replayed on. */
  rsiEvalWindows: number;
  /** Minimum hours between two scheduled generations for one group. */
  rsiEveryHours: number;
  /** A window needs at least this many messages to be used for evaluation. */
  rsiMinMessages: number;
  /** Judge win rate a candidate needs against the champion to be adopted. */
  promoteThreshold: number;
  /** Telegram user ids allowed to add the bot to groups and to administer it everywhere. Empty = anyone. */
  ownerIds: number[];
  minDigestMessages: number;
  manualCooldownMinutes: number;
  maxTranscriptChars: number;
  maxMessageChars: number;
  /** Reader account (MTProto user session) for groups you do not run: api id/hash from my.telegram.org. */
  telegramApiId: number | null;
  telegramApiHash: string;
  readerSession: string;
  readerPollSeconds: number;
  /** Groups/channels to watch at startup (@username, t.me link or -100… id), reported to `reportTo`. */
  watch: string[];
  /** Chat that receives digests of watched groups: your user id (a DM with the bot) or a private group id. */
  reportTo: number | null;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function int(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`expected an integer in [${min}, ${max}], got "${raw}"`);
  return n;
}

function float(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`expected a number in [${min}, ${max}], got "${raw}"`);
  return n;
}

function oneOf<T extends string>(raw: string | undefined, allowed: readonly T[], def: T): T {
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim() as T;
  if (!allowed.includes(v)) throw new Error(`expected one of ${allowed.join(' | ')}, got "${raw}"`);
  return v;
}

function ids(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isSafeInteger(n)) throw new Error(`PULSE_OWNER_IDS: "${s}" is not a Telegram user id`);
      return n;
    });
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const field = <T>(name: string, read: () => T): T => {
    try {
      return read();
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
  };
  const timezone = env.PULSE_TIMEZONE?.trim() || 'Asia/Shanghai';
  const ownerIds = field('PULSE_OWNER_IDS', () => ids(env.PULSE_OWNER_IDS));
  if (!isValidTimezone(timezone)) throw new Error(`PULSE_TIMEZONE: unknown time zone "${timezone}"`);
  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    model: env.PULSE_MODEL?.trim() || 'claude-opus-5-5',
    digestEffort: field('PULSE_DIGEST_EFFORT', () => oneOf(env.PULSE_DIGEST_EFFORT, EFFORTS, 'high')),
    rsiEffort: field('PULSE_RSI_EFFORT', () => oneOf(env.PULSE_RSI_EFFORT, EFFORTS, 'high')),
    dbPath: env.PULSE_DB?.trim() || './data/pulse.db',
    timezone,
    digestHour: field('PULSE_DIGEST_HOUR', () => int(env.PULSE_DIGEST_HOUR, 9, 0, 23)),
    language: field('PULSE_LANGUAGE', () => oneOf(env.PULSE_LANGUAGE, ['auto', 'en', 'zh'] as const, 'auto')),
    rsiMode: field('PULSE_RSI_MODE', () => oneOf(env.PULSE_RSI_MODE, ['auto', 'propose', 'off'] as const, 'auto')),
    retentionDays: field('PULSE_RETENTION_DAYS', () => int(env.PULSE_RETENTION_DAYS, 7, 2, 365)),
    rsiCandidates: field('PULSE_RSI_CANDIDATES', () => int(env.PULSE_RSI_CANDIDATES, 2, 1, 4)),
    rsiEvalWindows: field('PULSE_RSI_EVAL_WINDOWS', () => int(env.PULSE_RSI_EVAL_WINDOWS, 2, 1, 5)),
    rsiEveryHours: field('PULSE_RSI_EVERY_HOURS', () => int(env.PULSE_RSI_EVERY_HOURS, 20, 0, 24 * 30)),
    rsiMinMessages: field('PULSE_RSI_MIN_MESSAGES', () => int(env.PULSE_RSI_MIN_MESSAGES, 30, 1, 1_000_000)),
    promoteThreshold: field('PULSE_RSI_PROMOTE_AT', () => float(env.PULSE_RSI_PROMOTE_AT, 0.625, 0.5, 1)),
    ownerIds,
    minDigestMessages: field('PULSE_MIN_MESSAGES', () => int(env.PULSE_MIN_MESSAGES, 5, 1, 10_000)),
    manualCooldownMinutes: field('PULSE_DIGEST_COOLDOWN_MIN', () => int(env.PULSE_DIGEST_COOLDOWN_MIN, 30, 0, 1440)),
    maxTranscriptChars: field('PULSE_MAX_TRANSCRIPT_CHARS', () =>
      int(env.PULSE_MAX_TRANSCRIPT_CHARS, 600_000, 20_000, 3_000_000),
    ),
    maxMessageChars: field('PULSE_MAX_MESSAGE_CHARS', () => int(env.PULSE_MAX_MESSAGE_CHARS, 2000, 200, 20_000)),
    telegramApiId: field('TELEGRAM_API_ID', () => (env.TELEGRAM_API_ID?.trim() ? int(env.TELEGRAM_API_ID, 0, 1, 2 ** 31) : null)),
    telegramApiHash: env.TELEGRAM_API_HASH?.trim() ?? '',
    readerSession: env.PULSE_READER_SESSION?.trim() || './data/reader.session',
    readerPollSeconds: field('PULSE_READER_POLL_SECONDS', () => int(env.PULSE_READER_POLL_SECONDS, 120, 30, 3600)),
    watch: (env.PULSE_WATCH ?? '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
    reportTo: field('PULSE_REPORT_TO', () => {
      const raw = env.PULSE_REPORT_TO?.trim();
      if (!raw) return ownerIds[0] ?? null;
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw new Error(`"${raw}" is not a Telegram chat id`);
      return n;
    }),
  };
}
