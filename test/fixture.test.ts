import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { produceDigest } from '../src/digest.ts';
import { FakeLlm } from '../src/fake-llm.ts';
import { loadFixture, scoreGroundTruth, seedFixture } from '../src/fixture.ts';
import { SEED_PLAYBOOK } from '../src/prompts.ts';
import { evolve } from '../src/rsi/evolve.ts';
import { SECTIONS } from '../src/schema.ts';
import { Clock, memoryStore, testConfig } from './helpers.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/alpha-builders.zh.json', import.meta.url));
const defaults = { language: 'auto' as const, digestHour: 9, timezone: 'Asia/Shanghai', rsiMode: 'auto' as const };

test('the synthetic fixture loads like live traffic, and its ground truth points at real messages of the right day', () => {
  const f = loadFixture(FIXTURE);
  const store = memoryStore(new Clock());
  const { chatId, days } = seedFixture(store, f, defaults);
  const bots = new Set(f.users.filter((u) => u.is_bot).map((u) => u.id));
  assert.equal(store.countMessages(chatId, 0, 2 ** 31), f.messages.filter((m) => !bots.has(m.from)).length);
  assert.equal(days.length, 2);
  const dateOf = new Map(f.messages.map((m) => [m.message_id, Date.parse(m.date) / 1000]));
  for (const day of days) {
    const gt = f.ground_truth[day.label];
    for (const section of SECTIONS) {
      for (const item of gt[section]) {
        for (const id of item.message_ids) {
          const t = dateOf.get(id);
          assert.ok(t !== undefined && t >= day.start && t < day.end, `${day.label} ${section} "${item.title}" cites ${id}`);
        }
      }
    }
  }
});

test('stand-in replay on the fixture: RSI adopts a better playbook and finds more planted items', async () => {
  const f = loadFixture(FIXTURE);
  const clock = new Clock();
  const store = memoryStore(clock);
  const { chatId, days } = seedFixture(store, f, defaults);
  const deps = { store, llm: new FakeLlm(), config: testConfig(), log: () => undefined, now: clock.now };
  const seed = store.champion(chatId, SEED_PLAYBOOK);
  let before = 0;
  for (const [i, day] of days.entries()) {
    clock.t = day.end;
    const { row } = await produceDigest(deps, store.getChat(chatId)!, day, seed, 'production');
    store.setPosted(row.id, [900 + i]);
    if (i === days.length - 1) before = scoreGroundTruth(row.digest, f.ground_truth[day.label]).inSection;
  }
  for (let g = 0; g < 2; g++) {
    clock.t += 3600;
    await evolve(deps, chatId, { force: true });
  }
  const champion = store.champion(chatId, SEED_PLAYBOOK);
  assert.ok(champion.version > 0);
  const last = days[days.length - 1];
  const after = scoreGroundTruth(store.digestFor(chatId, last.start, last.end, champion.version)!.digest, f.ground_truth[last.label]).inSection;
  assert.ok(after >= before, `ground truth found: ${before} → ${after}`);
});
