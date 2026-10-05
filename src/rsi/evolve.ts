// The recursive self-improvement loop for one group.
//
//   level 0  the playbook: how to digest this group. Mutated by the improver, kept only if it wins.
//   level 1  the improver's strategy notes: rewritten by the improver every round, from the record
//            of which of its own past edits won, lost or were voted out. The improver improves how
//            it improves.
//   anchor   what the system cannot rewrite for itself: the constitution (prompts.ts), the code
//            checks (fitness.ts), the selection rule below, and the judge notes, which change only
//            from reader feedback. Readers can also veto any adopted version.
//
// Selection is a (1+λ) tournament against the incumbent on recent days' windows: each candidate
// writes shadow digests of the same windows, a judge compares them with the champion's both ways
// round, and code checks grounding and coverage. One candidate is adopted only if it clears every gate.

import { produceDigest, loadTranscript, recordUsage, digestLanguage, type DigestDeps } from '../digest.ts';
import type { LlmUsage } from '../llm.ts';
import { SEED_PLAYBOOK, calibrateTask, critiqueTask, improveTask, type LineageLine } from '../prompts.ts';
import { CalibrateSchema, CritiqueSchema, ImproveSchema, type Critique } from '../schema.ts';
import type { ChatRow, DigestRow, GenomeRow, Store } from '../store.ts';
import { localDate, type Transcript, type Window } from '../transcript.ts';
import { formatMetrics, measure, normalize, type Metrics } from './fitness.ts';
import { duel } from './judge.ts';

export interface EvolveDeps extends DigestDeps {
  now: () => number;
}

export interface CandidateReport {
  version: number;
  operator: string;
  rationale: string;
  winRate: number;
  perWindow: number[];
  grounding: number;
  coverage: number | null;
  championGrounding: number;
  championCoverage: number | null;
  verdicts: string[];
  outcome: 'promoted' | 'pending' | 'rejected';
  why: string;
}

export interface EvolveReport {
  chatId: number;
  championBefore: number;
  championAfter: number;
  decision: 'promoted' | 'pending' | 'held' | 'skipped' | 'vetoed';
  reason: string;
  windows: { start: number; end: number; messages: number }[];
  calibrated: boolean;
  critique: string | null;
  invalid: { operator: string; why: string }[];
  candidates: CandidateReport[];
  improverNotes: string;
  costUsd: number;
}

export interface Veto {
  from: number;
  to: number;
  up: number;
  down: number;
}

/** Digests a newly adopted playbook writes before it is safe from a reader veto. */
export const PROBATION_DIGESTS = 3;
/** Down-votes needed (and at least twice the up-votes) to veto it. */
export const VETO_MIN_DOWN = 3;

const PLAYBOOK_MAX = 3000;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const meanOrNull = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? mean(v) : null;
};
const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);

/** Rolls the champion back to its parent if readers voted it down during probation. */
export function checkVeto(store: Store, chatId: number): Veto | null {
  const champ = store.champion(chatId, SEED_PLAYBOOK);
  if (champ.parent === null) return null;
  const t = store.tallyForVersion(chatId, champ.version, PROBATION_DIGESTS);
  if (t.down < VETO_MIN_DOWN || t.down < 2 * t.up) return null;
  const parent = store.genome(chatId, champ.parent);
  if (!parent) return null;
  store.crown(chatId, parent.version, 'vetoed');
  store.addGeneration({
    chatId,
    championVersion: champ.version,
    decision: `vetoed v${champ.version}`,
    report: { decision: 'vetoed', from: champ.version, to: parent.version, up: t.up, down: t.down },
    costUsd: 0,
  });
  return { from: champ.version, to: parent.version, up: t.up, down: t.down };
}

export function validatePlaybook(text: string, current: string, others: string[], vetoed: string[] = []): string | null {
  const t = text.trim();
  if (t.length < 80) return 'too short to be a playbook';
  if (t.length > PLAYBOOK_MAX) return `too long (${t.length} > ${PLAYBOOK_MAX} characters)`;
  if (/https?:\/\/|www\.|t\.me\//i.test(t)) return 'contains a URL';
  if (/(^|[\s(])@\w{3,}/.test(t)) return 'contains an @mention';
  if (/(?<![A-Za-z0-9_])U\d{1,4}(?![0-9A-Za-z])/.test(t)) return 'names a member alias';
  const n = normalize(t);
  if (n === normalize(current)) return 'identical to the current playbook';
  if (others.some((o) => normalize(o) === n)) return 'duplicate of another candidate';
  if (vetoed.some((v) => normalize(v) === n)) return 'readers already voted this playbook out';
  return null;
}

function outcomeOf(g: GenomeRow, store: Store): string {
  switch (g.status) {
    case 'champion':
      return `adopted (${g.summary}); current champion`;
    case 'retired':
      return `adopted (${g.summary}); later replaced`;
    case 'vetoed': {
      const t = store.tallyForVersion(g.chatId, g.version, PROBATION_DIGESTS);
      return `adopted (${g.summary}), then voted out by readers (👎${t.down} 👍${t.up})`;
    }
    case 'pending':
      return 'waiting for an admin';
    default:
      return `rejected (${g.summary || 'invalid'})`;
  }
}

function lineage(store: Store, chatId: number): { lines: LineageLine[]; record: string } {
  const genomes = store.genomes(chatId, 40).filter((g) => g.operator !== 'seed');
  const lines = genomes.slice(0, 12).map((g) => ({
    version: g.version,
    parent: g.parent,
    operator: g.operator,
    rationale: g.rationale,
    outcome: outcomeOf(g, store),
  }));
  const tally = new Map<string, { n: number; adopted: number; vetoed: number }>();
  for (const g of genomes) {
    const t = tally.get(g.operator) ?? { n: 0, adopted: 0, vetoed: 0 };
    t.n++;
    if (g.status === 'champion' || g.status === 'retired' || g.status === 'vetoed') t.adopted++;
    if (g.status === 'vetoed') t.vetoed++;
    tally.set(g.operator, t);
  }
  const record = [...tally.entries()]
    .sort(([a, x], [b, y]) => y.adopted / y.n - x.adopted / x.n || y.n - x.n || a.localeCompare(b))
    .map(([op, t]) => `${op} ${t.adopted}/${t.n} adopted${t.vetoed ? ` (${t.vetoed} later voted out)` : ''}`)
    .join('; ');
  return { lines, record };
}

function readerFeedback(store: Store, chat: ChatRow, sinceVersion: GenomeRow): string {
  const lines: string[] = [];
  for (const d of store.productionDigests(chat.chatId, 7).reverse()) {
    if (d.postedIds.length === 0) continue;
    const t = store.tally(d.id);
    lines.push(`${localDate(d.windowEnd - 1, chat.timezone)} digest (playbook v${d.genomeVersion}): 👍 ${t.up}  👎 ${t.down}`);
  }
  const since = Math.min(sinceVersion.promotedAt ?? sinceVersion.createdAt, chat.lastEvolveAt ?? Number.MAX_SAFE_INTEGER) - 7 * 86_400;
  for (const f of store.feedbackSince(chat.chatId, since).slice(-30)) {
    lines.push(`comment: "${f.text.replace(/\s+/g, ' ').slice(0, 300)}"`);
  }
  return lines.join('\n');
}

function critiqueLines(c: Critique, label: string): string[] {
  const s = c.scores;
  return [
    `${label}: coverage ${s.coverage}/5, accuracy ${s.accuracy}/5, insight ${s.insight}/5, concision ${s.concision}/5. ${c.summary}`,
    ...c.missed.map((m) => `  missed: ${m.what} (${m.refs.map((r) => `#${r}`).join(', ')})`),
    ...c.misplaced.map((m) => `  misplaced: ${m}`),
    ...c.vague.map((m) => `  vague: ${m}`),
    ...c.noise.map((m) => `  noise: ${m}`),
  ];
}

/** Distils reader feedback into judge notes. Returns whether anything changed. */
async function calibrate(deps: EvolveDeps, chat: ChatRow, spend: (u: LlmUsage[]) => void): Promise<boolean> {
  const { store, llm, config } = deps;
  const since = chat.lastCalibratedAt ?? 0;
  const comments = store.feedbackSince(chat.chatId, since);
  if (comments.length === 0 && store.votesSince(chat.chatId, since) === 0) return false;
  const lines: string[] = [];
  for (const d of store.productionDigests(chat.chatId, 10).reverse()) {
    if (d.postedIds.length === 0) continue;
    const t = store.tally(d.id);
    lines.push(`${localDate(d.windowEnd - 1, chat.timezone)} digest: 👍 ${t.up}  👎 ${t.down}`);
  }
  for (const f of store.feedbackSince(chat.chatId, deps.now() - 14 * 86_400).slice(-40)) {
    lines.push(`comment: "${f.text.replace(/\s+/g, ' ').slice(0, 300)}"`);
  }
  const { data, usage } = await llm.json({
    role: 'calibrate',
    context: '',
    instructions: calibrateTask({ judgeNotes: chat.judgeNotes, feedback: lines.join('\n') }),
    schema: CalibrateSchema,
    effort: config.rsiEffort,
    maxTokens: 8000,
  });
  spend([usage]);
  store.updateChat(chat.chatId, { judgeNotes: data.judge_notes.trim().slice(0, 900), lastCalibratedAt: deps.now() });
  return true;
}

export async function evolve(deps: EvolveDeps, chatId: number, opts: { force?: boolean } = {}): Promise<EvolveReport> {
  const { store, llm, config, log } = deps;
  const chat = store.getChat(chatId);
  if (!chat) throw new Error(`unknown chat ${chatId}`);
  const champion = store.champion(chatId, SEED_PLAYBOOK);
  const report: EvolveReport = {
    chatId,
    championBefore: champion.version,
    championAfter: champion.version,
    decision: 'skipped',
    reason: '',
    windows: [],
    calibrated: false,
    critique: null,
    invalid: [],
    candidates: [],
    improverNotes: chat.improverNotes,
    costUsd: 0,
  };
  const skip = (reason: string) => {
    report.reason = reason;
    return report;
  };

  const veto = checkVeto(store, chatId);
  if (veto) {
    report.decision = 'vetoed';
    report.championAfter = veto.to;
    report.reason = `readers voted v${veto.from} down (👎${veto.down} 👍${veto.up}); back to v${veto.to}`;
    return report;
  }

  const now = deps.now();
  if (!opts.force) {
    if (chat.rsiMode === 'off') return skip('self-improvement is off for this group');
    if (chat.lastEvolveAt !== null && now - chat.lastEvolveAt < config.rsiEveryHours * 3600) return skip('evolved recently');
  }
  const pending = store.pendingGenome(chatId);
  if (pending) return skip(`v${pending.version} is waiting for an admin's decision`);

  // Evaluation windows: the latest posted days that still have enough stored messages.
  const windows: { window: Window; t: Transcript }[] = [];
  for (const d of store.productionDigests(chatId, config.rsiEvalWindows * 4)) {
    if (windows.length >= config.rsiEvalWindows) break;
    const w = { start: d.windowStart, end: d.windowEnd };
    if (windows.some((x) => x.window.start === w.start && x.window.end === w.end)) continue;
    const t = loadTranscript(deps, chat, w);
    if (t.messages.length >= config.rsiMinMessages) windows.push({ window: w, t });
  }
  report.windows = windows.map(({ window, t }) => ({ ...window, messages: t.messages.length }));
  if (windows.length === 0) return skip(`no posted day with at least ${config.rsiMinMessages} stored messages yet`);

  // Marked before any model call, so a failing run is not retried every minute.
  store.updateChat(chatId, { lastEvolveAt: now });
  let cost = 0;
  const spend = (u: LlmUsage[]) => {
    cost += recordUsage(store, chatId, u);
  };

  // 1. Reader feedback → judge notes. Nothing else may change how digests are judged.
  report.calibrated = await calibrate(deps, chat, spend);
  const judgeNotes = store.getChat(chatId)!.judgeNotes;

  // 2. The champion's digest of every window: the posted one when it wrote it, else a shadow.
  const championRows: DigestRow[] = [];
  for (const { window, t } of windows) {
    let row = store.digestFor(chatId, window.start, window.end, champion.version);
    if (!row) {
      const r = await produceDigest(deps, chat, window, champion, 'shadow', t);
      cost += r.cost;
      row = r.row;
    }
    championRows.push(row);
  }
  const championMetrics: Metrics[] = championRows.map((r, i) => r.metrics ?? measure(r.digest, windows[i].t));

  // 3. The editor's critique of the latest champion digest.
  const latest = championRows[0];
  let critique = latest.critique;
  if (!critique) {
    const { data, usage } = await llm.json({
      role: 'critique',
      context: windows[0].t.text,
      instructions: critiqueTask(latest.digest, champion.version),
      schema: CritiqueSchema,
      effort: config.rsiEffort,
      maxTokens: 16_000,
    });
    spend([usage]);
    critique = data;
    store.setCritique(latest.id, data);
  }
  report.critique = critique.summary;
  const critiques: string[] = [];
  for (const [i, r] of championRows.entries()) {
    const c = i === 0 ? critique : r.critique;
    if (c) critiques.push(...critiqueLines(c, localDate(r.windowEnd - 1, chat.timezone)));
  }

  // 4. The improver: mutated playbooks, plus its own rewritten strategy notes (the recursive level).
  const history = lineage(store, chatId);
  const { data: proposal, usage: improveUsage } = await llm.json({
    role: 'improve',
    context: windows[0].t.text,
    instructions: improveTask({
      playbook: champion.playbook,
      version: champion.version,
      improverNotes: chat.improverNotes,
      lineage: history.lines,
      operatorRecord: history.record,
      critiques,
      metrics: championMetrics
        .map((m, i) => `${localDate(windows[i].window.end - 1, chat.timezone)}: ${formatMetrics(m).replace(/\n/g, '\n  ')}`)
        .join('\n'),
      readerFeedback: readerFeedback(store, chat, champion),
      candidates: config.rsiCandidates,
      language: digestLanguage(chat, windows[0].t),
    }),
    schema: ImproveSchema,
    effort: config.rsiEffort,
    maxTokens: 32_000,
  });
  spend([improveUsage]);
  const notes = proposal.improver_notes.trim().slice(0, 1500);
  store.updateChat(chatId, { improverNotes: notes });
  report.improverNotes = notes;

  const candidates: { operator: string; rationale: string; playbook: string }[] = [];
  const vetoed = store.genomes(chatId, 1000).filter((g) => g.status === 'vetoed').map((g) => g.playbook);
  for (const c of proposal.candidates) {
    if (candidates.length >= config.rsiCandidates) break;
    const why = validatePlaybook(c.playbook, champion.playbook, candidates.map((x) => x.playbook), vetoed);
    if (why) report.invalid.push({ operator: c.operator, why });
    else candidates.push({ operator: c.operator, rationale: c.rationale.trim(), playbook: c.playbook.trim() });
  }

  // 5. Replay every candidate on every window and duel it against the champion.
  const championGrounding = mean(championMetrics.map((m) => m.grounding));
  const championCoverage = meanOrNull(championMetrics.map((m) => m.coverage));
  for (const c of candidates) {
    const version = store.nextVersion(chatId);
    store.addGenome({ chatId, version, parent: champion.version, ...c, status: 'rejected', winRate: null, summary: '' });
    const genome = store.genome(chatId, version)!;
    const perWindow: number[] = [];
    const verdicts: string[] = [];
    const metrics: Metrics[] = [];
    for (const [i, { window, t }] of windows.entries()) {
      const r = await produceDigest(deps, chat, window, genome, 'shadow', t);
      cost += r.cost;
      metrics.push(r.row.metrics!);
      const { duel: d, usages } = await duel(llm, t, championRows[i].digest, r.row.digest, judgeNotes, config.rsiEffort);
      spend(usages);
      perWindow.push(d.score);
      verdicts.push(...d.verdicts.map((v) => `${v.winner} (${v.confidence}): ${v.reasons}`));
    }
    const grounding = mean(metrics.map((m) => m.grounding));
    const coverage = meanOrNull(metrics.map((m) => m.coverage));
    const winRate = mean(perWindow);
    let why = '';
    if (!(grounding >= championGrounding - 0.02 || grounding >= 0.95)) {
      why = `grounding fell (${pct(championGrounding)} → ${pct(grounding)})`;
    } else if (coverage !== null && championCoverage !== null && coverage < championCoverage - 0.1) {
      why = `coverage fell (${pct(championCoverage)} → ${pct(coverage)})`;
    } else if (winRate < config.promoteThreshold) {
      why = `did not win clearly (judge ${pct(winRate)}, needs ${pct(config.promoteThreshold)})`;
    }
    report.candidates.push({
      version,
      operator: c.operator,
      rationale: c.rationale,
      winRate,
      perWindow,
      grounding,
      coverage,
      championGrounding,
      championCoverage,
      verdicts,
      outcome: 'rejected',
      why,
    });
    log(`chat ${chatId}: v${version} [${c.operator}] judge ${pct(winRate)}, grounding ${pct(grounding)}, coverage ${pct(coverage)} ${why ? `✗ ${why}` : '✓'}`);
  }

  // 6. Select: the best candidate that cleared every gate, if any.
  const eligible = report.candidates
    .filter((c) => c.why === '')
    .sort(
      (a, b) =>
        b.winRate - a.winRate ||
        (b.coverage ?? 0) - (a.coverage ?? 0) ||
        store.genome(chatId, a.version)!.playbook.length - store.genome(chatId, b.version)!.playbook.length,
    );
  const best = eligible[0];
  const mode = chat.rsiMode === 'auto' ? 'auto' : 'propose';
  for (const c of report.candidates) {
    const summary = `judge ${pct(c.winRate)} · grounding ${pct(c.championGrounding)}→${pct(c.grounding)} · coverage ${pct(c.championCoverage)}→${pct(c.coverage)}`;
    if (c === best) {
      c.outcome = mode === 'auto' ? 'promoted' : 'pending';
      c.why = mode === 'auto' ? 'won; adopted' : 'won; waiting for an admin';
    } else if (c.why === '') {
      c.why = 'cleared the gates, but another candidate did better';
    }
    store.addGenomeResult(chatId, c.version, c.winRate, summary);
  }

  if (!best) {
    report.decision = 'held';
    report.reason = candidates.length ? 'no candidate beat the champion clearly' : 'the improver produced no valid candidate';
  } else if (mode === 'auto') {
    store.crown(chatId, best.version);
    report.decision = 'promoted';
    report.championAfter = best.version;
    report.reason = best.rationale;
  } else {
    store.setGenomeStatus(chatId, best.version, 'pending');
    report.decision = 'pending';
    report.reason = best.rationale;
  }
  report.costUsd = cost;
  store.addGeneration({
    chatId,
    championVersion: champion.version,
    decision: best ? `${report.decision} v${best.version}` : report.decision,
    report,
    costUsd: cost,
  });
  return report;
}
