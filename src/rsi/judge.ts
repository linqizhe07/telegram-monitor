import type { Effort } from '../config.ts';
import type { Llm, LlmUsage } from '../llm.ts';
import { judgeTask } from '../prompts.ts';
import { JudgeSchema, type Digest } from '../schema.ts';
import type { Transcript } from '../transcript.ts';

export interface Verdict {
  order: 'challenger-first' | 'champion-first';
  winner: 'challenger' | 'champion' | 'tie';
  confidence: string;
  reasons: string;
}

export interface Duel {
  /** 1 = the challenger won in both orders, 0.5 = split or tie, 0 = the champion won both. */
  score: number;
  verdicts: Verdict[];
  championWeaknesses: string[];
  challengerWeaknesses: string[];
}

/**
 * Pairwise comparison on one window, run twice with the positions swapped so a judge that
 * prefers whichever digest comes first cannot decide the outcome.
 */
export async function duel(
  llm: Llm,
  t: Transcript,
  champion: Digest,
  challenger: Digest,
  judgeNotes: string,
  effort: Effort,
): Promise<{ duel: Duel; usages: LlmUsage[] }> {
  const usages: LlmUsage[] = [];
  const verdicts: Verdict[] = [];
  const championWeaknesses: string[] = [];
  const challengerWeaknesses: string[] = [];

  for (const order of ['challenger-first', 'champion-first'] as const) {
    const [a, b] = order === 'challenger-first' ? [challenger, champion] : [champion, challenger];
    // Sequential on purpose: the second call reads the transcript from the prompt cache.
    const { data, usage } = await llm.json({
      role: 'judge',
      context: t.text,
      instructions: judgeTask(a, b, judgeNotes),
      schema: JudgeSchema,
      effort,
      maxTokens: 16_000,
    });
    usages.push(usage);
    const aIs = order === 'challenger-first' ? 'challenger' : 'champion';
    const bIs = aIs === 'challenger' ? 'champion' : 'challenger';
    const winner = data.winner === 'tie' ? 'tie' : data.winner === 'A' ? aIs : bIs;
    verdicts.push({ order, winner, confidence: data.confidence, reasons: data.reasons });
    (aIs === 'champion' ? championWeaknesses : challengerWeaknesses).push(...data.a_weaknesses);
    (bIs === 'champion' ? championWeaknesses : challengerWeaknesses).push(...data.b_weaknesses);
  }

  const points: number[] = verdicts.map((v) => (v.winner === 'challenger' ? 1 : v.winner === 'tie' ? 0.5 : 0));
  return {
    duel: {
      score: points.reduce((s, p) => s + p, 0) / points.length,
      verdicts,
      championWeaknesses,
      challengerWeaknesses,
    },
    usages,
  };
}
