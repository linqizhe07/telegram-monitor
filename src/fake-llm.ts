// A deterministic stand-in for Claude, for tests and `npm run replay -- --fake`.
// It reads the same prompts the real model gets and answers with simple heuristics, so every
// code path (citations, coverage, duels, mutations, vetoes) runs without an API key.
// Its playbook "knob" is the sentence "Cover at least N conversations." — the fake improver
// raises N, the fake judge prefers digests that cite more real messages.

import type { Llm, LlmRequest, LlmUsage, Role } from './llm.ts';
import type { Critique, Digest, Improvement, Judgement } from './schema.ts';

interface Line {
  id: number;
  alias: string;
  replyTo: number | null;
  reactions: number;
  text: string;
}

const LINE = /^\[#(\d+) \d\d:\d\d (U\??\d+)(?: ↩(\d+))?(?: ♥(\d+))?\] (.*)$/;

export function parseTranscript(context: string): Line[] {
  const out: Line[] = [];
  for (const raw of context.split('\n')) {
    const m = LINE.exec(raw);
    if (m) out.push({ id: Number(m[1]), alias: m[2], replyTo: m[3] ? Number(m[3]) : null, reactions: m[4] ? Number(m[4]) : 0, text: m[5] });
  }
  return out;
}

function between(s: string, open: RegExp, close: string): string {
  const m = open.exec(s);
  if (!m) return '';
  const start = m.index + m[0].length;
  const end = s.indexOf(close, start);
  return end < 0 ? s.slice(start) : s.slice(start, end);
}

/** Reply threads, busiest first. */
function threads(lines: Line[]): Line[][] {
  const root = new Map<number, number>();
  const byId = new Map(lines.map((l) => [l.id, l]));
  const find = (id: number): number => {
    let r = id;
    while (root.has(r) && root.get(r) !== r) r = root.get(r)!;
    return r;
  };
  for (const l of lines) {
    root.set(l.id, l.id);
    if (l.replyTo !== null && byId.has(l.replyTo)) root.set(find(l.id), find(l.replyTo));
  }
  const groups = new Map<number, Line[]>();
  for (const l of lines) {
    const r = find(l.id);
    groups.set(r, [...(groups.get(r) ?? []), l]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => b.length + b.reduce((s, l) => s + l.reactions, 0) - (a.length + a.reduce((s, l) => s + l.reactions, 0)) || a[0].id - b[0].id);
}

const PAIN = /痛|卡|难|贵|慢|坑|没法|问题|pain|problem|stuck|broken|slow|expensive/i;
const IDEA = /想法|可以做|要不要|做个|不如|建议|idea|we could|what if|propose/i;
const OPPORTUNITY = /机会|没人做|缺口|空白|opportunity|gap|nobody/i;
const QUESTION = /[?？]\s*$/;

function item(ls: Line[]) {
  const first = ls[0];
  return {
    title: first.text.slice(0, 18),
    detail: `${first.alias}: ${first.text.slice(0, 60)}`,
    people: [...new Set(ls.map((l) => l.alias))],
    refs: ls.slice(0, 3).map((l) => l.id),
    evidence: [first.text.slice(0, 12)],
    continues: '',
  };
}

function fakeDigest(req: LlmRequest<unknown>): Digest {
  if (req.role === 'merge') {
    const parts = [...req.context.matchAll(/<part index="\d+">\n([\s\S]*?)\n<\/part>/g)].map((m) => JSON.parse(m[1]) as Digest);
    return {
      headline: parts[0]?.headline ?? '',
      topics: parts.flatMap((p) => p.topics),
      pain_points: parts.flatMap((p) => p.pain_points),
      ideas: parts.flatMap((p) => p.ideas),
      opportunities: parts.flatMap((p) => p.opportunities),
      open_questions: parts.flatMap((p) => p.open_questions),
      quiet: parts.every((p) => p.quiet),
    };
  }
  const lines = parseTranscript(req.context);
  const playbook = between(req.instructions, /<playbook[^>]*>/, '</playbook>');
  const n = Number(/Cover at least (\d+) conversations/.exec(playbook)?.[1] ?? 3);
  const topics = threads(lines).slice(0, n).map(item);
  if (playbook.includes('FAKE_HALLUCINATE') && topics[0]) topics[0].refs.push(987_654_321);
  const pick = (re: RegExp, k: number) => lines.filter((l) => re.test(l.text)).slice(0, k).map((l) => item([l]));
  return {
    headline: topics[0] ? `${topics[0].title}…` : '',
    topics,
    pain_points: pick(PAIN, 3).map((x) => ({ ...x, severity: 'medium' as const })),
    ideas: pick(IDEA, 2),
    opportunities: pick(OPPORTUNITY, 2).map((x) => ({ ...x, why_now: 'raised today', next_step: 'ask who wants to try it' })),
    open_questions: lines.filter((l) => QUESTION.test(l.text) && !lines.some((r) => r.replyTo === l.id)).slice(0, 2).map((l) => item([l])),
    quiet: lines.length < 5,
  };
}

function fakeJudge(req: LlmRequest<unknown>): Judgement {
  const ids = new Set(parseTranscript(req.context).map((l) => l.id));
  const score = (view: string) => {
    const refs = [...view.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    return new Set(refs.filter((r) => ids.has(r))).size - 10 * refs.filter((r) => !ids.has(r)).length;
  };
  const a = score(between(req.instructions, /<digest id="A">/, '</digest>'));
  const b = score(between(req.instructions, /<digest id="B">/, '</digest>'));
  const winner = a > b ? 'A' : b > a ? 'B' : 'tie';
  return {
    winner,
    confidence: a === b ? 'low' : 'medium',
    reasons: `A cites ${a} distinct real messages, B cites ${b}.`,
    a_weaknesses: a < b ? ['covers fewer conversations'] : [],
    b_weaknesses: b < a ? ['covers fewer conversations'] : [],
  };
}

function fakeCritique(req: LlmRequest<unknown>): Critique {
  const cited = new Set([...between(req.instructions, /<digest>/, '</digest>').matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  const missed = threads(parseTranscript(req.context))
    .filter((t) => !t.some((l) => cited.has(l.id)))
    .slice(0, 3)
    .map((t) => ({ what: t[0].text.slice(0, 30), refs: t.slice(0, 2).map((l) => l.id) }));
  return {
    missed,
    misplaced: [],
    vague: [],
    noise: [],
    scores: { coverage: missed.length ? 2 : 4, accuracy: 4, insight: 3, concision: 4 },
    summary: missed.length ? 'Several busy conversations are missing.' : 'Solid.',
  };
}

function fakeImprove(req: LlmRequest<unknown>): Improvement {
  const pb = between(req.instructions, /<current_playbook[^>]*>/, '</current_playbook>').trim();
  const n = Number(/Cover at least (\d+) conversations/.exec(pb)?.[1] ?? 3);
  const wider = /Cover at least \d+ conversations\./.test(pb)
    ? pb.replace(/Cover at least \d+ conversations\./, `Cover at least ${n + 2} conversations.`)
    : `${pb}\n- Cover at least ${n + 2} conversations.`;
  const lines = pb.split('\n');
  const shorter = lines.length > 6 ? lines.slice(0, -1).join('\n') : `${pb}\n- Keep every item to one sentence.`;
  const rounds = (req.instructions.match(/^v\d+ ←/gm) ?? []).length;
  return {
    improver_notes: `After ${rounds} earlier proposal(s): widening coverage is the lever that moves the judge here; trimming has not helped yet.`,
    candidates: [
      { operator: 'repair', rationale: `Cover ${n + 2} conversations instead of ${n}.`, playbook: wider },
      { operator: 'simplify', rationale: 'Trim the last instruction.', playbook: shorter },
    ],
  };
}

type Handler = (req: LlmRequest<unknown>) => unknown;

const DEFAULTS: Record<Role, Handler> = {
  digest: fakeDigest,
  merge: fakeDigest,
  critique: fakeCritique,
  judge: fakeJudge,
  improve: fakeImprove,
  calibrate: () => ({ judge_notes: 'Readers want every busy conversation covered, briefly.' }),
};

export class FakeLlm implements Llm {
  readonly model = 'fake';
  readonly calls: { role: Role; instructions: string; context: string }[] = [];
  private readonly handlers: Partial<Record<Role, Handler>>;

  constructor(handlers: Partial<Record<Role, Handler>> = {}) {
    this.handlers = handlers;
  }

  async json<T>(req: LlmRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    this.calls.push({ role: req.role, instructions: req.instructions, context: req.context });
    const handler = this.handlers[req.role] ?? DEFAULTS[req.role];
    const data = req.schema.parse(handler(req as LlmRequest<unknown>));
    const usage: LlmUsage = {
      role: req.role,
      model: this.model,
      inputTokens: Math.ceil((req.context.length + req.instructions.length) / 3),
      outputTokens: 400,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    return { data, usage };
  }

  count(role: Role): number {
    return this.calls.filter((c) => c.role === role).length;
  }
}
