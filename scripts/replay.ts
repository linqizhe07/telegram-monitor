// Offline replay: loads a two-day group chat, posts the day digests with the seed playbook,
// runs N self-improvement generations on those days, and reports what changed, with the
// fixture's planted ground truth as an outside check the loop itself never sees.
//
//   npm run replay -- --fake                      no API key: deterministic stand-in model
//   npm run replay -- --generations 2             live, with ANTHROPIC_API_KEY
//   npm run replay -- --answers <dir>             prompt dry run: every model call is written to
//                                                 <dir> as a request file and read back from an
//                                                 answer file; re-run after answering each one
//   options: --fixture <path> --generations <n> --feedback "<reader comment>" --out <dir>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { digestLanguage, produceDigest, streaks, type DigestDeps } from '../src/digest.ts';
import { FakeLlm } from '../src/fake-llm.ts';
import { loadFixture, scoreGroundTruth, seedFixture, type FixtureDay } from '../src/fixture.ts';
import { AnthropicLlm, type Llm, type LlmRequest, type LlmUsage } from '../src/llm.ts';
import { SEED_PLAYBOOK, SYSTEM_PROMPT } from '../src/prompts.ts';
import { aliasNames, renderDigest, toPlain } from '../src/render.ts';
import { evolve, type EvolveReport } from '../src/rsi/evolve.ts';
import { formatMetrics, measure } from '../src/rsi/fitness.ts';
import type { DigestRow } from '../src/store.ts';
import { Store } from '../src/store.ts';
import { loadTranscript } from '../src/digest.ts';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}

class PendingAnswer extends Error {
  readonly request: string;
  readonly answer: string;
  constructor(request: string, answer: string) {
    super(`answer needed: ${answer}`);
    this.request = request;
    this.answer = answer;
  }
}

/** Answers each model call from a file, writing the full request out when the answer is missing. */
class FileLlm implements Llm {
  readonly model = 'answers-from-files';
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  async json<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const key = createHash('sha256').update(`${req.role}\n${req.context}\n${req.instructions}`).digest('hex').slice(0, 12);
    const answer = join(this.dir, `${req.role}-${key}.answer.json`);
    if (existsSync(answer)) {
      const data = req.schema.parse(JSON.parse(readFileSync(answer, 'utf8')));
      return { data, usage: { role: req.role, model: this.model, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } };
    }
    const request = join(this.dir, `${req.role}-${key}.request.md`);
    writeFileSync(
      request,
      [
        `# Model request · role: ${req.role} · effort: ${req.effort}`,
        '## System prompt',
        SYSTEM_PROMPT,
        '## User message, content block 1 (cached context)',
        req.context || '(empty)',
        '## User message, content block 2 (task)',
        req.instructions,
        '## Output: one JSON object matching this JSON Schema (structured output)',
        JSON.stringify(z.toJSONSchema(req.schema), null, 2),
        `## Answer file\n${answer}`,
      ].join('\n\n'),
    );
    throw new PendingAnswer(request, answer);
  }
}

const fake = arg('fake') !== undefined;
const answersDir = arg('answers');
const fixturePath = arg('fixture', 'fixtures/alpha-builders.zh.json')!;
const generations = Number(arg('generations', '2'));
const feedback = arg('feedback');
const outDir = arg('out', 'data')!;

const config = { ...loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: 'replay' }), rsiMode: 'auto' as const };
const fixture = loadFixture(fixturePath);
let clock = 0;
const store = new Store(':memory:', () => clock);
const { chatId, days } = seedFixture(store, fixture, {
  language: config.language,
  digestHour: config.digestHour,
  timezone: fixture.meta.timezone,
  rsiMode: 'auto',
});
const chat = () => store.getChat(chatId)!;
clock = days[days.length - 1].end;

if (!fake && !answersDir && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Set ANTHROPIC_API_KEY for a live replay, or pass --fake for the deterministic stand-in.');
  process.exit(1);
}
const llm: Llm = fake ? new FakeLlm() : answersDir ? new FileLlm(answersDir) : new AnthropicLlm({ model: config.model });
const out: string[] = [];
const say = (line = '') => {
  console.log(line);
  out.push(line);
};
const log = (line: string) => console.log(`  · ${line}`);
const deps: DigestDeps & { now: () => number } = { store, llm, config, log, now: () => clock };
const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const gtFor = (label: string): FixtureDay | undefined => fixture.ground_truth[label];

say(`# Pulse replay · ${fixture.meta.chat.title}`);
say();
say(`Model: ${llm.model}${fake ? ' (deterministic stand-in, no API calls)' : ` · effort digest ${config.digestEffort} / RSI ${config.rsiEffort}`}`);
say(`Fixture: ${fixturePath} (${fixture.meta.synthetic ? 'synthetic' : 'recorded'}, ${fixture.messages.length} messages, ${days.length} days)`);
say();

function show(row: DigestRow, label: string, title: string) {
  const t = loadTranscript(deps, chat(), { start: row.windowStart, end: row.windowEnd });
  const parts = renderDigest(row.digest, {
    chat: chat(),
    names: aliasNames(store.users(chatId)),
    window: { start: row.windowStart, end: row.windowEnd },
    timezone: chat().timezone,
    lang: digestLanguage(chat(), t),
    stats: { messages: t.messages.length, people: t.people },
    version: row.genomeVersion,
    validIds: new Set(t.byId.keys()),
    streaks: streaks(store, row.digest),
  });
  const m = row.metrics ?? measure(row.digest, t);
  say(`## ${title}`);
  say();
  say('```');
  say(parts.map(toPlain).join('\n\n'));
  say('```');
  say();
  say(`Checks: ${formatMetrics(m).split('\n').join(' · ')}`);
  const gt = gtFor(label);
  if (gt) {
    const g = scoreGroundTruth(row.digest, gt);
    say(`Ground truth (outside check): ${g.inSection}/${g.total} planted items found in the right section, ${g.anywhere}/${g.total} anywhere; ${g.noiseCited} of ${g.cited} cited messages are labelled noise.`);
  }
  say();
}

function report(g: number, r: EvolveReport) {
  say(`## Generation ${g}: ${r.decision}${r.championAfter !== r.championBefore ? ` (v${r.championBefore} → v${r.championAfter})` : ` (champion stays v${r.championBefore})`}`);
  say();
  if (r.critique) say(`Editor on the champion: ${r.critique}`);
  if (r.calibrated) say(`Judge notes recalibrated from reader feedback: ${chat().judgeNotes.replace(/\n/g, ' / ')}`);
  for (const inv of r.invalid) say(`- discarded [${inv.operator}]: ${inv.why}`);
  for (const c of r.candidates) {
    say(
      `- v${c.version} [${c.operator}] ${c.outcome.toUpperCase()} · judge ${pct(c.winRate)} (per day ${c.perWindow.map(pct).join(', ')}) · ` +
        `grounding ${pct(c.championGrounding)}→${pct(c.grounding)} · coverage ${pct(c.championCoverage)}→${pct(c.coverage)} · ${c.why}`,
    );
    say(`  rationale: ${c.rationale}`);
  }
  say(`Improver notes now: ${r.improverNotes.replace(/\n/g, ' / ')}`);
  say(`Spend this generation: ~$${r.costUsd.toFixed(2)}`);
  say();
}

async function run() {
  // 1. The day digests the seed playbook posts.
  const seed = store.champion(chatId, SEED_PLAYBOOK);
  let postedId = 900_000;
  for (const day of days) {
    clock = day.end;
    const { row } = await produceDigest(deps, chat(), day, seed, 'production');
    store.setPosted(row.id, [postedId++]);
    show(row, day.label, `${day.label} · digest posted by playbook v0 (seed)`);
  }
  if (feedback && feedback !== 'true') {
    const last = store.latestPosted(chatId)!;
    store.addFeedback(chatId, last.id, 0, feedback);
    say(`Reader feedback added to the last digest: "${feedback}"`);
    say();
  }

  // 2. Self-improvement generations on those days.
  for (let g = 1; g <= generations; g++) {
    clock += 3600;
    report(g, await evolve(deps, chatId, { force: true }));
  }

  // 3. Where it ended up: the champion's digest of the last day, against the seed's.
  const champion = store.champion(chatId, SEED_PLAYBOOK);
  if (champion.version !== seed.version) {
    const lastDay = days[days.length - 1];
    const row = store.digestFor(chatId, lastDay.start, lastDay.end, champion.version);
    if (row) show(row, lastDay.label, `${lastDay.label} · the same day by playbook v${champion.version} (after RSI)`);
  }
  say(`## Playbook v${champion.version}`);
  say();
  say('```');
  say(champion.playbook);
  say('```');
  say();
  const cost = store.costSince(chatId, 0);
  say(`Total model spend: ~$${(cost.digest + cost.rsi).toFixed(2)} (digests $${cost.digest.toFixed(2)}, RSI $${cost.rsi.toFixed(2)})${fake ? ' (stand-in: no real calls)' : ''}`);

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `replay-${new Date().toISOString().replace(/[:.]/g, '-')}${fake ? '-fake' : answersDir ? '-dryrun' : ''}.md`);
  writeFileSync(file, `${out.join('\n')}\n`);
  console.log(`\nReport written to ${file}`);
  store.close();
}

run().catch((err) => {
  if (err instanceof PendingAnswer) {
    console.log(`\nWaiting for a model answer.\n  request: ${err.request}\n  answer:  ${err.answer}\nRe-run the same command once the answer file exists.`);
    process.exit(3);
  }
  console.error(err);
  process.exit(1);
});
