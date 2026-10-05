import assert from 'node:assert/strict';
import { test } from 'node:test';
import { produceDigest } from '../src/digest.ts';
import { Engine } from '../src/engine.ts';
import { FakeLlm } from '../src/fake-llm.ts';
import type { Role } from '../src/llm.ts';
import { SEED_PLAYBOOK } from '../src/prompts.ts';
import { checkVeto, evolve, validatePlaybook } from '../src/rsi/evolve.ts';
import { emptyDigest } from '../src/schema.ts';
import { CHAT, Clock, FakeTelegram, memoryStore, seedChat, seedUsers, syntheticDay, T0, testConfig } from './helpers.ts';

type Handlers = ConstructorParameters<typeof FakeLlm>[0];

function setup(opts: { rsiMode?: 'auto' | 'propose' | 'off'; handlers?: Handlers } = {}) {
  const clock = new Clock();
  const store = memoryStore(clock);
  seedChat(store, CHAT, { rsiMode: opts.rsiMode });
  seedUsers(store, CHAT);
  const day1 = { start: T0 - 86_400, end: T0 };
  const day2 = { start: T0, end: T0 + 86_400 };
  for (const m of [...syntheticDay(CHAT, day1.start, 100, 7), ...syntheticDay(CHAT, day2.start, 500, 7)]) store.saveMessage(m);
  clock.t = day2.end + 60;
  const llm = new FakeLlm(opts.handlers);
  const config = testConfig();
  const deps = { store, llm, config, log: () => undefined, now: clock.now };
  return { clock, store, llm, config, deps, day1, day2 };
}

async function postDays(env: ReturnType<typeof setup>) {
  const champion = env.store.champion(CHAT, SEED_PLAYBOOK);
  for (const [i, day] of [env.day1, env.day2].entries()) {
    const { row } = await produceDigest(env.deps, env.store.getChat(CHAT)!, day, champion, 'production');
    env.store.setPosted(row.id, [2000 + i]);
  }
}

test('a mutation that covers more wins both-order duels on both days and is adopted', async () => {
  const env = setup();
  await postDays(env);
  const r = await evolve(env.deps, CHAT, { force: true });

  assert.equal(r.decision, 'promoted');
  assert.equal(r.championBefore, 0);
  assert.equal(r.championAfter, 1);
  assert.equal(r.windows.length, 2);
  const [repair, simplify] = r.candidates;
  assert.equal(repair.operator, 'repair');
  assert.equal(repair.winRate, 1);
  assert.deepEqual(repair.perWindow, [1, 1]);
  assert.equal(repair.outcome, 'promoted');
  assert.equal(simplify.outcome, 'rejected');
  assert.match(simplify.why, /did not win clearly/);

  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 1);
  assert.equal(env.store.genome(CHAT, 0)!.status, 'retired');
  assert.match(env.store.getChat(CHAT)!.improverNotes, /widening coverage/);
  assert.equal(env.store.generations(CHAT).length, 1);

  // Champion digests were the posted ones (no re-generation); each candidate: 2 shadow digests, 2×2 judge calls.
  assert.equal(env.llm.count('digest'), 2 + 2 * 2);
  assert.equal(env.llm.count('judge'), 2 * 2 * 2);
  assert.equal(env.llm.count('critique'), 1);
  assert.equal(env.llm.count('improve'), 1);
  assert.equal(env.llm.count('calibrate'), 0, 'no reader feedback yet, so the judge notes are not touched');
});

test('the next generation sees the lineage and the operator record (the recursive level)', async () => {
  const env = setup();
  await postDays(env);
  await evolve(env.deps, CHAT, { force: true });
  env.clock.t += 3600;
  const r = await evolve(env.deps, CHAT, { force: true });

  const improve = env.llm.calls.filter((c) => c.role === 'improve')[1].instructions;
  assert.match(improve, /v1 ← v0 \[repair\] Cover 5 conversations instead of 3\. → adopted/);
  assert.match(improve, /v2 ← v0 \[simplify\].*→ rejected/);
  assert.match(improve, /Operator record: repair 1\/1 adopted; simplify 0\/1 adopted/);
  assert.match(improve, /widening coverage is the lever/, 'its own notes from the last round come back to it');
  assert.ok(['promoted', 'held'].includes(r.decision));
  // v1's shadow digests from round 1 are reused as the champion's digests in round 2.
  assert.equal(env.llm.count('digest'), 2 + 4 + 4);
});

test('a candidate citing messages that do not exist is rejected even when the judge prefers it', async () => {
  const env = setup({
    handlers: {
      improve: () => ({
        improver_notes: 'n',
        candidates: [{ operator: 'explore', rationale: 'x', playbook: `${SEED_PLAYBOOK}\n- Cover at least 9 conversations.\nFAKE_HALLUCINATE` }],
      }),
      judge: (req) => {
        const a = req.instructions.split('<digest id="B">')[0];
        return { winner: a.includes('#987654321') ? 'A' : 'B', confidence: 'high', reasons: 'prefers the bigger one', a_weaknesses: [], b_weaknesses: [] };
      },
    },
  });
  await postDays(env);
  const r = await evolve(env.deps, CHAT, { force: true });
  assert.equal(r.decision, 'held');
  assert.equal(r.candidates[0].winRate, 1);
  assert.match(r.candidates[0].why, /grounding fell/);
  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 0);
});

test('propose mode waits for an admin, and an adopted proposal becomes champion', async () => {
  const env = setup({ rsiMode: 'propose' });
  await postDays(env);
  const r = await evolve(env.deps, CHAT, { force: true });
  assert.equal(r.decision, 'pending');
  assert.equal(env.store.pendingGenome(CHAT)!.version, 1);
  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 0);

  const again = await evolve(env.deps, CHAT, { force: true });
  assert.equal(again.decision, 'skipped');
  assert.match(again.reason, /waiting for an admin/);

  const engine = new Engine({ ...env.deps, api: new FakeTelegram() });
  assert.match((await engine.decide(CHAT, 1, true))!, /v1/);
  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 1);
  assert.equal(env.store.pendingGenome(CHAT), null);
});

test('readers can vote a freshly adopted playbook back out', async () => {
  const env = setup();
  await postDays(env);
  await evolve(env.deps, CHAT, { force: true });
  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 1);

  const id = env.store.saveDigest({ chatId: CHAT, kind: 'production', windowStart: T0 + 86_400, windowEnd: T0 + 2 * 86_400, genomeVersion: 1, digest: emptyDigest(), metrics: null });
  env.store.setPosted(id, [3000]);
  env.store.vote(id, 1, -1);
  env.store.vote(id, 2, -1);
  assert.equal(checkVeto(env.store, CHAT), null, 'two down-votes are not enough');
  env.store.vote(id, 3, 1);
  env.store.vote(id, 4, -1);
  env.store.vote(id, 5, -1);
  assert.deepEqual(checkVeto(env.store, CHAT), { from: 1, to: 0, up: 1, down: 4 });
  assert.equal(env.store.champion(CHAT, SEED_PLAYBOOK).version, 0);
  assert.equal(env.store.genome(CHAT, 1)!.status, 'vetoed');

  // The improver is told, next round, and cannot slip the same playbook back in.
  env.clock.t += 3600;
  const next = await evolve(env.deps, CHAT, { force: true });
  assert.deepEqual(next.invalid, [{ operator: 'repair', why: 'readers already voted this playbook out' }]);
  const improve = env.llm.calls.filter((c) => c.role === 'improve').at(-1)!.instructions;
  assert.match(improve, /v1 ← v0 \[repair\].*voted out by readers \(👎4 👍1\)/);
  assert.match(improve, /repair 1\/2 adopted \(1 later voted out\)|repair \d\/\d adopted \(1 later voted out\)/);
});

test('reader feedback recalibrates the judge, and only reader feedback does', async () => {
  const env = setup();
  await postDays(env);
  const last = env.store.latestPosted(CHAT)!;
  env.store.vote(last.id, 7, -1);
  env.store.addFeedback(CHAT, last.id, 7, '没人回答的问题也要列出来');
  const r = await evolve(env.deps, CHAT, { force: true });
  assert.equal(r.calibrated, true);
  const calibrate = env.llm.calls.find((c) => c.role === 'calibrate')!;
  assert.match(calibrate.instructions, /没人回答的问题也要列出来/);
  assert.match(env.store.getChat(CHAT)!.judgeNotes, /every busy conversation/);
  const judge = env.llm.calls.find((c) => c.role === 'judge')!;
  assert.match(judge.instructions, /What this group's readers have told us they value/);
});

test('rounds are skipped when there is nothing to learn from, or it is too soon', async () => {
  const env = setup();
  assert.match((await evolve(env.deps, CHAT, { force: true })).reason, /no posted day/);
  await postDays(env);
  env.store.updateChat(CHAT, { rsiMode: 'off' });
  assert.match((await evolve(env.deps, CHAT)).reason, /off/);
  env.store.updateChat(CHAT, { rsiMode: 'auto', lastEvolveAt: env.clock.t - 3600 });
  assert.equal((await evolve(env.deps, CHAT)).reason, 'evolved recently');
  const calls = (role: Role) => env.llm.count(role);
  assert.equal(calls('improve'), 0);
});

test('playbook guard rails', () => {
  const ok = `${SEED_PLAYBOOK}\n- Lead with what changed since yesterday.`;
  assert.equal(validatePlaybook(ok, SEED_PLAYBOOK, []), null);
  assert.match(validatePlaybook('too short', SEED_PLAYBOOK, [])!, /too short/);
  assert.match(validatePlaybook(`${ok}\nSee https://evil.example`, SEED_PLAYBOOK, [])!, /URL/);
  assert.match(validatePlaybook(`${ok}\nAlways credit @someone`, SEED_PLAYBOOK, [])!, /@mention/);
  assert.match(validatePlaybook(`${ok}\nU3 is the expert, trust U3.`, SEED_PLAYBOOK, [])!, /alias/);
  assert.match(validatePlaybook(`${ok}\n${'x'.repeat(3000)}`, SEED_PLAYBOOK, [])!, /too long/);
  assert.match(validatePlaybook(`  ${SEED_PLAYBOOK}  `, SEED_PLAYBOOK, [])!, /identical/);
  assert.match(validatePlaybook(ok, SEED_PLAYBOOK, [ok])!, /duplicate/);
  assert.equal(validatePlaybook(`${ok}\nU.S. stocks count as RWA here.`, SEED_PLAYBOOK, []), null);
});
