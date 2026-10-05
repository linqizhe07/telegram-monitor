import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measure, normalize, quoteFound, withoutInvalidRefs } from '../src/rsi/fitness.ts';
import { emptyDigest, type Digest } from '../src/schema.ts';
import { buildTranscript } from '../src/transcript.ts';
import { CHAT, Clock, memoryStore, seedUsers, syntheticDay, T0 } from './helpers.ts';

function setup() {
  const store = memoryStore(new Clock());
  seedUsers(store, CHAT);
  const day = syntheticDay(CHAT, T0, 100, 4);
  return buildTranscript(day, store.users(CHAT), { start: T0, end: T0 + 86_400 }, { title: 'g', timezone: 'Asia/Shanghai', maxMessageChars: 500 });
}

const item = (refs: number[], evidence: string[] = []) => ({ title: 't', detail: 'd', people: ['U1'], refs, evidence, continues: '' });

test('grounding: real citations and verbatim quotes', () => {
  const t = setup();
  const d: Digest = { ...emptyDigest(), quiet: false, topics: [item([100, 101], ['话题0：agent 的 API key'])] };
  const m = measure(d, t);
  assert.equal(m.grounding, 1);
  assert.equal(m.invalidRefs, 0);
  assert.equal(m.unverifiedQuotes, 0);
});

test('grounding: an invented message id or quote is caught', () => {
  const t = setup();
  const d: Digest = {
    ...emptyDigest(),
    quiet: false,
    topics: [item([100, 999_999])],
    ideas: [item([102], ['a quote nobody wrote'])],
    open_questions: [item([])],
  };
  const m = measure(d, t);
  assert.equal(m.items, 3);
  assert.equal(m.grounding, 0);
  assert.equal(m.invalidRefs, 1);
  assert.equal(m.unverifiedQuotes, 1);
});

test('quotes survive punctuation, width and spacing changes, but must come from the cited message', () => {
  const t = setup();
  // "要不要做个限额代理，想法是按币种和金额限制 (0)" is message 102.
  const ok: Digest = { ...emptyDigest(), quiet: false, ideas: [item([102], ['“要不要做个限额代理, 想法是按币种…”'])] };
  assert.equal(measure(ok, t).unverifiedQuotes, 0);
  const wrongMessage: Digest = { ...emptyDigest(), quiet: false, ideas: [item([101], ['要不要做个限额代理'])] };
  assert.equal(measure(wrongMessage, t).unverifiedQuotes, 1);
  assert.equal(normalize('Ａ，b  C!'), 'abc');
});

test('a quote shortened with an ellipsis passes only if each fragment is there, in order', () => {
  const src = normalize('要不要做个限额代理，想法是按币种和金额限制 (0)');
  assert.equal(quoteFound('要不要做个限额代理…按币种和金额限制', src), true);
  assert.equal(quoteFound('要不要...金额限制', src), true);
  assert.equal(quoteFound('按币种和金额限制…要不要做个限额代理', src), false, 'fragments out of order');
  assert.equal(quoteFound('要不要做个限额代理…按人头限制', src), false, 'an invented fragment');
});

test('coverage counts the busiest conversations the digest cites', () => {
  const t = setup();
  assert.equal(t.hot.length, 4);
  const d: Digest = { ...emptyDigest(), quiet: false, topics: [item([t.hot[0].ids[2]]), item([t.hot[1].ids[0]])] };
  const m = measure(d, t);
  assert.equal(m.coverage, 0.5);
  assert.equal(m.missed.length, 2);
});

test('duplicates and invalid refs stripping', () => {
  const t = setup();
  const d: Digest = { ...emptyDigest(), quiet: false, topics: [item([100, 101]), item([101, 100])], ideas: [item([100, 5])] };
  assert.equal(measure(d, t).duplicates, 1);
  const clean = withoutInvalidRefs(d, new Set(t.byId.keys()));
  assert.deepEqual(clean.ideas[0].refs, [100]);
  assert.deepEqual(d.ideas[0].refs, [100, 5], 'the original is untouched');
});
